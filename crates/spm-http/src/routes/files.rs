use std::io::Read;
use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use axum::routing::{get, patch, post};
use futures_util::TryStreamExt;
use spm_core::validate::{self, FileRenameInput};
use spm_core::{
    AppError, delete_file, rename_file, resolve_file_path, resolve_preview_path, upload_file,
};
use tokio_util::io::{ReaderStream, StreamReader, SyncIoBridge};

use crate::decorate::decorate_file;
use crate::error::{ApiError, blocking};
use crate::extract::{ParsedJson, Session, json, no_content};
use crate::percent::{decode_uri_component_or_fail, encode_uri_component};
use crate::state::AppState;

pub const UPLOAD_NAME_HEADER: &str = "x-spm-file-name";

/// The most of a refused upload's body that is read and thrown away before the refusal is sent.
const DRAIN_LIMIT: u64 = 512 * 1024 * 1024;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/projects/{id}/files", post(upload))
        .route("/api/files/{id}", patch(rename).delete(remove))
        .route("/api/files/{id}/raw", get(raw))
        .route("/api/files/{id}/thumb", get(thumb))
}

/// The request body as a blocking [`Read`]: bytes are pulled from the socket one frame at a time as
/// the reader asks for them, so memory use does not depend on the upload's size. Only for use on a
/// blocking thread, inside `spawn_blocking`.
pub(crate) fn body_reader(body: Body) -> impl Read + Send + 'static {
    let stream = body.into_data_stream().map_err(std::io::Error::other);
    SyncIoBridge::new(StreamReader::new(stream))
}

/// Reads what is left of a refused upload's body and discards it.
///
/// The quota and the other checks run before a byte is read, so a refusal is ready while the client
/// is still sending. Answering and closing with the body unread makes the client's operating system
/// reset the connection, and the refusal never arrives: a browser reports a network error instead of
/// "over quota". Taking the rest off the socket first lets the answer through. Bounded by
/// [`DRAIN_LIMIT`]; past it (or when the client stops sending) the connection is dropped as before.
fn drain(reader: &mut impl Read) {
    let _ = std::io::copy(&mut reader.take(DRAIN_LIMIT), &mut std::io::sink());
}

fn require_upload_name(headers: &HeaderMap) -> Result<String, ApiError> {
    let raw = headers
        .get(UPLOAD_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation(format!("{UPLOAD_NAME_HEADER} header is required")))?;
    let decoded = decode_uri_component_or_fail(raw, &format!("{UPLOAD_NAME_HEADER} header"))?;
    if let Err(message) = validate::file_name(&decoded) {
        let mut details = serde_json::Map::new();
        details.insert(
            "issues".into(),
            serde_json::json!([{ "message": message, "path": [] }]),
        );
        return Err(AppError::validation("illegal file name")
            .with_details(details)
            .into());
    }
    Ok(decoded)
}

/// The declared body size. 411 when it is missing or not a whole number: the quota check must
/// know the size before a byte is written.
pub(crate) fn require_content_length(
    headers: &HeaderMap,
    allow_empty: bool,
) -> Result<u64, ApiError> {
    let size = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|size| allow_empty || *size > 0);
    size.ok_or_else(|| {
        AppError::new(
            spm_core::AppErrorCode::LengthRequired,
            "content-length is required",
        )
        .into()
    })
}

async fn upload(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let name = require_upload_name(&headers)?;
    let size = require_content_length(&headers, true)?;
    let size = i64::try_from(size)
        .map_err(|_| AppError::validation("the declared upload size is too large"))?;
    let lib = state.lib().clone();
    let file = blocking(move || {
        let mut reader = body_reader(body);
        let result = upload_file(&lib, &ctx, &project_id, &name, size, &mut reader);
        if result.is_err() {
            drain(&mut reader);
        }
        result
    })
    .await?;
    Ok(json(&decorate_file(&file)))
}

async fn rename(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
    ParsedJson(input): ParsedJson<FileRenameInput>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let file = blocking(move || rename_file(&lib, &ctx, &id, &input.name)).await?;
    Ok(json(&decorate_file(&file)))
}

async fn remove(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    blocking(move || delete_file(&lib, &ctx, &id)).await?;
    Ok(no_content())
}

/// Streams a file off disk. Bulk bytes never pass through JSON.
///
/// A file row can outlive its bytes: rescan marks a file `missing` without deleting the row, and
/// the bytes can also vanish underneath the server between the database read and this open. Either
/// way the honest answer is a 404, not a logged 500.
async fn stream_file(
    path: PathBuf,
    content_type: &str,
    file_name: &str,
) -> Result<Response, ApiError> {
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::not_found("file is missing on disk").into());
        }
        Err(error) => return Err(AppError::from(error).into()),
    };
    let length = file.metadata().await.map_err(AppError::from)?.len();
    let mut response = Response::new(Body::from_stream(ReaderStream::with_capacity(
        file,
        64 * 1024,
    )));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    if let Ok(value) = HeaderValue::from_str(&format!(
        "inline; filename*=UTF-8''{}",
        encode_uri_component(file_name)
    )) {
        headers.insert(CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

async fn raw(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let resolved = blocking(move || resolve_file_path(&lib, &ctx, &id)).await?;
    stream_file(resolved.abs_path, resolved.content_type, &resolved.name).await
}

async fn thumb(
    State(state): State<AppState>,
    Session(ctx): Session,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let lib = state.lib().clone();
    let file_id = id.clone();
    let preview = blocking(move || resolve_preview_path(&lib, &ctx, &file_id)).await?;
    let path = preview.ok_or_else(|| AppError::not_found("no preview is ready for this file"))?;
    let mut response = stream_file(path, "image/png", &format!("{id}.png")).await?;
    // The URL is stable while the preview is regenerated on content change, so keep it short.
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=60"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use std::convert::Infallible;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The memory bound of an upload is that the body is pulled from the socket as the writer
    /// asks for it, one frame at a time, instead of being collected first.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_body_is_pulled_a_frame_at_a_time_not_collected() {
        const FRAMES: usize = 1000;
        const FRAME: usize = 1024;
        let pulled = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&pulled);
        let frames = (0..FRAMES).map(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok::<_, Infallible>(Bytes::from(vec![7u8; FRAME]))
        });
        let body = Body::from_stream(futures_util::stream::iter(frames));

        let observed = Arc::clone(&pulled);
        let (first_read, total) = tokio::task::spawn_blocking(move || {
            let mut reader = body_reader(body);
            let mut buffer = [0u8; 100];
            reader.read_exact(&mut buffer).unwrap();
            let after_first = observed.load(Ordering::SeqCst);
            let mut rest = Vec::new();
            reader.read_to_end(&mut rest).unwrap();
            (after_first, buffer.len() + rest.len())
        })
        .await
        .unwrap();

        assert!(
            first_read <= 2,
            "{first_read} frames were pulled for 100 bytes"
        );
        assert_eq!(total, FRAMES * FRAME);
    }
}
