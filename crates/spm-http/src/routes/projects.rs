use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::response::Response;
use axum::routing::{delete, get, post};
use serde_json::{Map, Value, json as json_value};
use spm_core::dto::ProjectQuery;
use spm_core::validate::{CreateProjectInput, ProjectPatch, TagBody, parse_project_query};
use spm_core::{
    AppError, add_tag, create_project, delete_project, get_project, list_projects, list_tags,
    remove_tag, rescan, update_project,
};

use crate::decorate::{decorate_project, decorate_project_detail};
use crate::error::{ApiError, blocking};
use crate::extract::{ParsedJson, Session, json, no_content};
use crate::percent::decode_uri_component_or_fail;
use crate::state::AppState;

pub(super) fn routes() -> Router<AppState> {
    // `/api/projects/rescan` and `/api/projects/tags` are literals; the router prefers them to
    // `{id}`, so neither is ever read as an id.
    Router::new()
        .route("/api/projects", get(list).post(create))
        .route("/api/projects/rescan", post(rescan_route))
        .route("/api/projects/tags", get(tags))
        .route(
            "/api/projects/{id}",
            get(detail).patch(patch).delete(remove),
        )
        .route("/api/projects/{id}/tags", post(add))
        .route("/api/projects/{id}/tags/{name}", delete(remove_tag_route))
}

/// What `Number(text)` makes of a query value, as far as a limit or an offset cares: empty is 0,
/// anything that is not a finite decimal is not a number (and so fails validation instead of being
/// guessed at).
fn js_number(text: &str) -> Value {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Value::from(0);
    }
    let numeric = trimmed
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.' | b'e' | b'E'));
    match trimmed.parse::<f64>() {
        Ok(number) if numeric && number.is_finite() => {
            if number.fract() == 0.0 && number.abs() < 9e15 {
                Value::from(number as i64)
            } else {
                serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
            }
        }
        _ => Value::String(text.to_owned()),
    }
}

/// Query strings are all text: coerce, then validate with core's rules.
///
/// A query that fails validation is refused with a 400, not silently treated as an empty query.
/// Paging added `limit` and `offset`, numeric fields a caller can produce programmatically from
/// scroll arithmetic, and one malformed value must not discard `search`, `tags`, `sort`, `dir` and
/// `includeArchived` along with it and answer 200 with the whole unfiltered library: exactly the
/// outcome paging exists to prevent.
pub(crate) fn parse_project_query_string(query: Option<&str>) -> Result<ProjectQuery, AppError> {
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let first = |name: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let mut raw = Map::new();
    if let Some(search) = first("search").filter(|value| !value.is_empty()) {
        raw.insert("search".into(), Value::from(search));
    }
    let tags: Vec<Value> = pairs
        .iter()
        .filter(|(key, _)| key == "tags")
        .map(|(_, value)| Value::from(value.as_str()))
        .collect();
    if !tags.is_empty() {
        raw.insert("tags".into(), Value::Array(tags));
    }
    if let Some(value) = first("includeArchived") {
        raw.insert("includeArchived".into(), Value::Bool(value == "true"));
    }
    for name in ["sort", "dir"] {
        if let Some(value) = first(name).filter(|value| !value.is_empty()) {
            raw.insert(name.into(), Value::from(value));
        }
    }
    for name in ["limit", "offset"] {
        if let Some(value) = first(name) {
            raw.insert(name.into(), js_number(value));
        }
    }
    parse_project_query(&Value::Object(raw)).map_err(|issues| {
        let mut details = Map::new();
        details.insert("issues".into(), json_value!(issues.0));
        AppError::validation("invalid project query").with_details(details)
    })
}

async fn list(
    State(state): State<AppState>,
    Session(ctx): Session,
    uri: Uri,
) -> Result<Response, ApiError> {
    let query = parse_project_query_string(uri.query())?;
    let lib = state.lib().clone();
    let projects = blocking(move || list_projects(&lib, &ctx, &query)).await?;
    Ok(json(
        &projects.iter().map(decorate_project).collect::<Vec<_>>(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Session(ctx): Session,
    ParsedJson(input): ParsedJson<CreateProjectInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let project = blocking(move || create_project(&lib, &ctx, input)).await?;
    Ok(json(&decorate_project(&project)))
}

/// Reconciles the user's folder with the database. The legacy route answered with the result
/// only, with no progress stream; the CLI importers are what report progress.
async fn rescan_route(
    State(state): State<AppState>,
    Session(ctx): Session,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(&blocking(move || rescan(&lib, &ctx, None)).await?))
}

async fn tags(State(state): State<AppState>, Session(ctx): Session) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    Ok(json(&blocking(move || list_tags(&lib, &ctx)).await?))
}

async fn detail(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let detail = blocking(move || get_project(&lib, &ctx, &id)).await?;
    Ok(json(&decorate_project_detail(&detail)))
}

async fn patch(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    ParsedJson(patch): ParsedJson<ProjectPatch>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let project = blocking(move || update_project(&lib, &ctx, &id, patch)).await?;
    Ok(json(&decorate_project(&project)))
}

async fn remove(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response, ApiError> {
    let delete_files = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .any(|(key, value)| key == "deleteFiles" && value == "true");
    let lib = state.lib().clone();
    blocking(move || delete_project(&lib, &ctx, &id, delete_files)).await?;
    Ok(no_content())
}

async fn add(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    ParsedJson(body): ParsedJson<TagBody>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    blocking(move || add_tag(&lib, &ctx, &id, &body.name)).await?;
    Ok(no_content())
}

/// The name is in the path, so there is no DELETE body. It is read **raw** from the request path
/// and decoded here: the router decodes path parameters for you but passes a lone `%` through, and
/// a malformed escape must be a 400 while `100%25%20infill` must round-trip.
async fn remove_tag_route(
    State(state): State<AppState>,
    Session(ctx): Session,
    uri: Uri,
) -> Result<Response, ApiError> {
    // `/api/projects/{id}/tags/{name}`: the route matched, so the segments are where they are.
    let mut segments = uri.path().split('/');
    let id = segments.nth(3).unwrap_or_default();
    let raw_name = segments.nth(1).unwrap_or_default();
    let id = crate::percent::try_decode_uri_component(id).unwrap_or_default();
    let name = decode_uri_component_or_fail(raw_name, "tag name")?;
    let lib = state.lib().clone();
    blocking(move || remove_tag(&lib, &ctx, &id, &name)).await?;
    Ok(no_content())
}

#[cfg(test)]
mod tests {
    use super::*;
    use spm_core::AppErrorCode;

    #[test]
    fn parse_project_query_reads_limit_and_offset() {
        let query = parse_project_query_string(Some("limit=10&offset=5")).unwrap();
        assert_eq!(query.limit, Some(10));
        assert_eq!(query.offset, Some(5));
        assert_eq!(
            parse_project_query_string(None).unwrap(),
            ProjectQuery::default()
        );
        assert_eq!(
            parse_project_query_string(Some("")).unwrap(),
            ProjectQuery::default()
        );
    }

    #[test]
    fn parse_project_query_rejects_a_value_the_rules_refuse() {
        for query in [
            "limit=abc",
            "limit=0",
            "limit=-1",
            "limit=201",
            "limit=1.5",
            "offset=-1",
            "limit=Infinity",
            "limit=NaN",
            "sort=bogus",
            "dir=sideways",
        ] {
            let error = parse_project_query_string(Some(query)).unwrap_err();
            assert_eq!(error.code, AppErrorCode::Validation, "{query}");
        }
    }

    #[test]
    fn the_other_fields_are_read_as_the_legacy_server_read_them() {
        let query = parse_project_query_string(Some(
            "search=bench&tags=petg&tags=boat&includeArchived=true&sort=name&dir=desc",
        ))
        .unwrap();
        assert_eq!(query.search.as_deref(), Some("bench"));
        assert_eq!(query.tags, Some(vec!["petg".to_owned(), "boat".to_owned()]));
        assert_eq!(query.include_archived, Some(true));
        // An empty `search` or `sort` is absent, anything but `true` is false.
        let empty = parse_project_query_string(Some("search=&sort=&includeArchived=yes")).unwrap();
        assert_eq!(empty.search, None);
        assert_eq!(empty.sort, None);
        assert_eq!(empty.include_archived, Some(false));
    }

    #[test]
    fn js_number_follows_number_for_what_a_limit_can_be() {
        assert_eq!(js_number("10"), Value::from(10));
        assert_eq!(js_number(" 10 "), Value::from(10));
        assert_eq!(js_number(""), Value::from(0));
        assert_eq!(js_number("1e1"), Value::from(10));
        assert!(js_number("1.5").is_number());
        assert!(js_number("abc").is_string());
        assert!(js_number("inf").is_string());
    }
}
