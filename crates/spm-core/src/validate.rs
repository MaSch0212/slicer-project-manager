//! Input validation: the rules the legacy `contract/schemas.ts` expressed as Zod schemas.
//!
//! **The server is the authority.** Every rule lives here, once, in core; the web package only
//! repeats the cheap ones for form UX and is checked against this by the e2e suite. A request body
//! is parsed with [`parse`], which deserialises it into one of the input types below and runs its
//! [`Validate`] rules; a failure is [`Issues`], which converts into the `Validation` error with the
//! same `{ issues: [{ message, path }] }` details the legacy server answered with.
//!
//! Two details are kept on purpose from the JavaScript original, because they are observable:
//! lengths are counted in UTF-16 code units (what `string.length` measured, so a 60-unit tag limit
//! stays a 60-unit limit), and "trim" strips the ECMAScript whitespace set.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;
use url::Url;

use crate::dto::double_option;
use crate::error::AppError;

/// The longest search term the project query accepts. The UI caps its box at the same number: a
/// query that fails validation is refused, so a search the box let the user type but the rules
/// refuse would turn a paste into a hard failure instead of a narrower result set.
pub const SEARCH_MAX_LENGTH: usize = 200;
/// The largest page a project query may ask for.
pub const PROJECT_LIMIT_MAX: i64 = 200;
/// How many tags a remembered filter (and so a stored `filterTags` setting) may hold.
pub const FILTER_TAGS_MAX: usize = 50;

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

/// One thing wrong with one field of a request, shaped like a Standard Schema issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    pub message: String,
    pub path: Vec<String>,
}

/// One or more [`Issue`]s. Never empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issues(pub Vec<Issue>);

impl Issues {
    pub fn single(path: &[&str], message: impl Into<String>) -> Issues {
        Issues(vec![Issue {
            message: message.into(),
            path: path.iter().map(|segment| (*segment).to_owned()).collect(),
        }])
    }

    /// The path of the first issue, joined with dots; handy in tests and logs.
    pub fn first_path(&self) -> String {
        self.0
            .first()
            .map(|issue| issue.path.join("."))
            .unwrap_or_default()
    }
}

impl From<Issues> for AppError {
    fn from(issues: Issues) -> AppError {
        let mut details = Map::new();
        details.insert("issues".into(), json!(issues.0));
        AppError::validation("request body failed validation").with_details(details)
    }
}

/// Collects issues across the fields of one input, as a schema reports every failing field.
#[derive(Default)]
struct Collector(Vec<Issue>);

impl Collector {
    fn check<T>(&mut self, path: &[&str], result: Result<T, String>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(message) => {
                self.0.extend(Issues::single(path, message).0);
                None
            }
        }
    }

    fn finish(self) -> Result<(), Issues> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(Issues(self.0))
        }
    }
}

/// Rules an input type enforces. `validate` also normalises (trims) what the rules say to trim,
/// and returns the cleaned value.
pub trait Validate: Sized {
    fn validate(self) -> Result<Self, Issues>;
}

/// Deserialises `value` into `T` and applies its rules. A value of the wrong shape (a string where
/// a number belongs, an unknown enum member, a fractional `limit`) is one issue carrying serde's
/// description.
pub fn parse<T: DeserializeOwned + Validate>(value: &Value) -> Result<T, Issues> {
    let parsed: T = serde_json::from_value(value.clone())
        .map_err(|error| Issues::single(&[], error.to_string()))?;
    parsed.validate()
}

// ---------------------------------------------------------------------------------------------
// JavaScript string semantics
// ---------------------------------------------------------------------------------------------

/// `string.length`: UTF-16 code units.
pub(crate) fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// ECMAScript `WhiteSpace` and `LineTerminator`: what `String.prototype.trim` strips.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

fn length_between(value: &str, min: usize, max: usize, what: &str) -> Result<(), String> {
    let length = js_len(value);
    if length < min {
        Err(if min == 1 {
            format!("{what} must not be empty")
        } else {
            format!("{what} must be at least {min} characters")
        })
    } else if length > max {
        Err(format!("{what} must be at most {max} characters"))
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------------------------

/// 2 to 32 characters, letters, digits, dot, dash and underscore, starting with a letter or digit.
pub fn username(value: &str) -> Result<(), String> {
    length_between(value, 2, 32, "username")?;
    let mut chars = value.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if first_ok && rest_ok {
        Ok(())
    } else {
        Err("letters, digits, dot, dash and underscore only".to_owned())
    }
}

/// The password floor and ceiling: 10 to 200 characters.
pub fn password(value: &str) -> Result<(), String> {
    length_between(value, 10, 200, "password")
}

pub fn display_name(value: &str) -> Result<(), String> {
    length_between(value, 1, 100, "display name")
}

/// A tag name, trimmed: 1 to 60 characters once the whitespace is gone. Returns the trimmed name.
pub fn tag_name(value: &str) -> Result<String, String> {
    let trimmed = js_trim(value);
    length_between(trimmed, 1, 60, "tag name")?;
    Ok(trimmed.to_owned())
}

/// The remembered projects-page tag filter: at most 50 valid tag names. Returns them trimmed.
pub fn filter_tags(values: &[String]) -> Result<Vec<String>, String> {
    if values.len() > FILTER_TAGS_MAX {
        return Err(format!("at most {FILTER_TAGS_MAX} tags"));
    }
    values.iter().map(|value| tag_name(value)).collect()
}

fn project_name(value: &str) -> Result<String, String> {
    let trimmed = js_trim(value);
    length_between(trimmed, 1, 200, "name")?;
    Ok(trimmed.to_owned())
}

fn notes(value: &str) -> Result<(), String> {
    length_between(value, 0, 10_000, "notes")
}

/// A URL the way `z.url()` accepts one: anything the WHATWG parser accepts as an absolute URL.
/// That is deliberately permissive about the scheme (`javascript:` parses); only
/// [`server_url`] narrows it.
pub fn website(value: &str) -> Result<(), String> {
    Url::parse(value)
        .map(|_| ())
        .map_err(|_| "not a valid URL".to_owned())
}

/// A file name inside a project: no separators, no Windows-reserved characters, no traversal, no
/// dotfiles, no Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an
/// extension, in any case). Spaces are legal.
pub fn file_name(value: &str) -> Result<(), String> {
    length_between(value, 1, 255, "file name")?;
    if value
        .chars()
        .any(|c| matches!(c, '"' | '*' | '/' | ':' | '<' | '>' | '?' | '\\' | '|'))
    {
        return Err("invalid characters in file name".to_owned());
    }
    if value.contains('\0') {
        return Err("file name must not contain a null byte".to_owned());
    }
    if value.starts_with('.') {
        return Err("file name must not start with a dot".to_owned());
    }
    if is_windows_device_name(value) {
        return Err("file name must not be a Windows-reserved device name".to_owned());
    }
    Ok(())
}

fn is_windows_device_name(value: &str) -> bool {
    // `^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)`, case-insensitively.
    let lower = value.to_ascii_lowercase();
    let stem_len = lower.find('.').unwrap_or(lower.len());
    let stem = &lower[..stem_len];
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            stem.strip_prefix(prefix)
                .is_some_and(|digit| digit.len() == 1 && matches!(digit.as_bytes()[0], b'1'..=b'9'))
        })
}

/// The address of a Slicer Project Manager server, as typed before a shell is pointed at it.
///
/// An origin and nothing else: `http:` or `https:` only (something about to become the origin of a
/// window must not be `javascript:`), no user name or password (it would be persisted as part of
/// the origin, and userinfo is the oldest trick for making one host read as another), and no path,
/// query or fragment (the shell refuses them, so the form must too or the user is told "could not
/// be reached" when nothing was contacted).
pub fn server_url(value: &str) -> Result<(), String> {
    let parsed = Url::parse(value).map_err(|_| "not a valid URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("the address must start with http:// or https://".to_owned());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("the address must not carry a user name or a password".to_owned());
    }
    // `new URL('https://h/?').search` is '' (an empty query is no query), and so is `hash`.
    if parsed.query().is_some_and(|query| !query.is_empty())
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
    {
        return Err("the address must not carry a query string or a fragment".to_owned());
    }
    if !(parsed.path().is_empty() || parsed.path() == "/") {
        return Err("the address must name a server, not a path on it".to_owned());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Integer fields
// ---------------------------------------------------------------------------------------------

/// Reads a JSON number that is a whole number, `1` and `1.0` alike (JavaScript's `Number.isInteger`
/// does not tell them apart).
fn whole_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    use serde::de::Error;
    let number = serde_json::Number::deserialize(deserializer)?;
    if let Some(n) = number.as_i64() {
        return Ok(n);
    }
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Ok(f as i64),
        _ => Err(D::Error::custom("expected an integer")),
    }
}

pub(crate) fn whole_number_opt<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    struct Whole(#[serde(deserialize_with = "whole_number")] i64);
    Ok(Option::<Whole>::deserialize(deserializer)?.map(|whole| whole.0))
}

/// `Option<Option<i64>>`: absent / `null` / a whole number.
fn whole_number_double_opt<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<i64>>, D::Error> {
    #[derive(Deserialize)]
    struct Whole(#[serde(deserialize_with = "whole_number")] i64);
    Ok(Some(
        Option::<Whole>::deserialize(deserializer)?.map(|whole| whole.0),
    ))
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub username: String,
    pub password: String,
}

impl Validate for LoginInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        issues.check(&["username"], non_empty(&self.username, "username"));
        issues.check(&["password"], non_empty(&self.password, "password"));
        issues.finish().map(|()| self)
    }
}

fn non_empty(value: &str, what: &str) -> Result<(), String> {
    length_between(value, 1, usize::MAX, what)
}

/// Setting the first password from an activation link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ActivateInput {
    pub password: String,
    pub confirm: String,
}

impl Validate for ActivateInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        if issues
            .check(&["password"], password(&self.password))
            .is_some()
            && self.password != self.confirm
        {
            // The mismatch is reported on `confirm`, and only once the password itself is fine.
            issues.check::<()>(&["confirm"], Err("passwords do not match".to_owned()));
        }
        issues.finish().map(|()| self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordInput {
    pub current: String,
    pub next: String,
}

impl Validate for ChangePasswordInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        issues.check(&["current"], non_empty(&self.current, "current password"));
        issues.check(&["next"], password(&self.next));
        issues.finish().map(|()| self)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_name: Option<String>,
}

impl Validate for ProfilePatch {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        if let Some(name) = &self.display_name {
            issues.check(&["displayName"], display_name(name));
        }
        issues.finish().map(|()| self)
    }
}

/// An administrator creating a user. `isAdmin` defaults to `false` and `quotaBytes` to `null`
/// (unlimited) when omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserInput {
    pub username: String,
    pub display_name: String,
    #[serde(default)]
    pub is_admin: bool,
    #[serde(default, deserialize_with = "whole_number_opt")]
    #[ts(type = "number | null")]
    pub quota_bytes: Option<i64>,
}

impl Validate for CreateUserInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        issues.check(&["username"], username(&self.username));
        issues.check(&["displayName"], display_name(&self.display_name));
        if let Some(quota) = self.quota_bytes {
            issues.check(&["quotaBytes"], positive(quota, "quota"));
        }
        issues.finish().map(|()| self)
    }
}

fn positive(value: i64, what: &str) -> Result<(), String> {
    if value > 0 {
        Ok(())
    } else {
        Err(format!("{what} must be greater than zero"))
    }
}

/// An administrator changing a user. An absent key is left alone; `quotaBytes: null` removes the
/// quota.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUserInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_admin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_disabled: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "whole_number_double_opt"
    )]
    #[ts(optional = nullable, type = "number")]
    pub quota_bytes: Option<Option<i64>>,
}

impl Validate for UpdateUserInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        if let Some(Some(quota)) = self.quota_bytes {
            issues.check(&["quotaBytes"], positive(quota, "quota"));
        }
        issues.finish().map(|()| self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TagBody {
    pub name: String,
}

impl Validate for TagBody {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        let name = issues.check(&["name"], tag_name(&self.name));
        issues.finish().map(|()| TagBody {
            name: name.unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
}

impl Validate for CreateProjectInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        let name = issues.check(&["name"], project_name(&self.name));
        if let Some(url) = &self.website {
            issues.check(&["website"], website(url));
        }
        if let Some(text) = &self.notes {
            issues.check(&["notes"], notes(text));
        }
        let tags = self.tags.as_ref().map(|tags| {
            tags.iter()
                .enumerate()
                .filter_map(|(index, tag)| {
                    issues.check(&["tags", &index.to_string()], tag_name(tag))
                })
                .collect::<Vec<_>>()
        });
        issues.finish().map(|()| CreateProjectInput {
            name: name.unwrap_or_default(),
            tags,
            ..self
        })
    }
}

/// A partial project update. `website` and `notes` distinguish "leave alone" (absent) from "clear"
/// (`null`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    #[ts(optional = nullable)]
    pub website: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    #[ts(optional = nullable)]
    pub notes: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_archived: Option<bool>,
}

impl Validate for ProjectPatch {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        let name = match &self.name {
            Some(name) => issues.check(&["name"], project_name(name)).map(Some),
            None => Some(None),
        };
        if let Some(Some(url)) = &self.website {
            issues.check(&["website"], website(url));
        }
        if let Some(Some(text)) = &self.notes {
            issues.check(&["notes"], notes(text));
        }
        issues.finish().map(|()| ProjectPatch {
            name: name.flatten(),
            ..self
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameInput {
    pub name: String,
}

impl Validate for FileRenameInput {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        issues.check(&["name"], file_name(&self.name));
        issues.finish().map(|()| self)
    }
}

impl Validate for crate::dto::SettingsPatch {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        let tags = self
            .filter_tags
            .as_deref()
            .and_then(|tags| issues.check(&["filterTags"], filter_tags(tags)));
        issues.finish().map(|()| crate::dto::SettingsPatch {
            filter_tags: tags,
            ..self
        })
    }
}

impl Validate for crate::dto::ProjectQuery {
    fn validate(self) -> Result<Self, Issues> {
        let mut issues = Collector::default();
        if let Some(search) = &self.search {
            issues.check(
                &["search"],
                length_between(search, 0, SEARCH_MAX_LENGTH, "search"),
            );
        }
        let tags = self.tags.as_ref().map(|tags| {
            tags.iter()
                .enumerate()
                .filter_map(|(index, tag)| {
                    issues.check(&["tags", &index.to_string()], tag_name(tag))
                })
                .collect::<Vec<_>>()
        });
        if let Some(limit) = self.limit
            && !(1..=PROJECT_LIMIT_MAX).contains(&limit)
        {
            issues.check::<()>(
                &["limit"],
                Err(format!("limit must be between 1 and {PROJECT_LIMIT_MAX}")),
            );
        }
        if let Some(offset) = self.offset
            && offset < 0
        {
            issues.check::<()>(&["offset"], Err("offset must not be negative".to_owned()));
        }
        issues
            .finish()
            .map(|()| crate::dto::ProjectQuery { tags, ..self })
    }
}

/// A project query as it arrives from a request. `limit` and `offset` must be whole numbers;
/// `limit` is 1 to 200; `offset` is 0 or more.
pub fn parse_project_query(value: &Value) -> Result<crate::dto::ProjectQuery, Issues> {
    parse(value)
}

/// A settings patch as it arrives from a request.
pub fn parse_settings_patch(value: &Value) -> Result<crate::dto::SettingsPatch, Issues> {
    parse(value)
}
