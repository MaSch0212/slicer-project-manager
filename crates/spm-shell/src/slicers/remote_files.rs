//! The three things the slicer subsystem asks a remote library for, and nothing else.
//!
//! **All of it goes through [`crate::remote::RemoteHost::proxy`], which is that type's only entry
//! point** (D spec 7.1). The proxy already holds the session cookie, already refuses redirects and
//! already confines every request to `/api` on the one configured origin: a second HTTP client
//! here, however small, would be a second copy of all four of those decisions with nothing keeping
//! them in step. What this module adds on top is the URL shapes, the two headers an upload needs,
//! and turning the server's error envelope back into an [`AppError`] (constraint 5).
//!
//! **The bytes never round-trip through the window.** A download is streamed from the proxy
//! straight into the launch directory, and an upload is streamed from the launch directory
//! straight back: the page names a `fileId` and a `projectId` and never sees either.
//!
//! The proxy arrives as the [`RemoteLibrary`] trait so every path runs under plain `cargo test`
//! against a recorder; [`ProxyRemote`] is the real one.
//!
//! **Known constraint, kept from the Electron build (D 7.5): a remote launch downloads the one
//! file that was asked for, not the whole project**, and Cura can never be promised a round trip
//! (its save is always a "save as" into a folder of its own), which the launch says in a notice.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::Request;
use futures_util::StreamExt;
use serde_json::Value;
use spm_core::dto::{FileKind, SlicerId};
use spm_core::{AppError, AppErrorCode};
use tokio_util::io::ReaderStream;

use crate::remote::{RemoteHost, UPLOAD_LENGTH_HEADER};

/// One answer from the remote server: a status and, for a small JSON call or a failed download,
/// its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl RemoteResponse {
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The one public entry point of the remote host, and all of it this subsystem uses. Blocking: the
/// slicer subsystem runs on blocking threads, and a recorder is trivial to write for a blocking
/// trait.
pub trait RemoteLibrary: Send + Sync {
    /// Which server this is, for the launch record. A launch directory outlives the library it
    /// came from, and in remote mode "the library" is an origin.
    fn origin(&self) -> &str;
    /// `GET /api<path>`, small JSON.
    fn get(&self, path: &str) -> Result<RemoteResponse, AppError>;
    /// `GET /api<path>` streamed into `destination` when the answer is 2xx; for any other status
    /// the (small) body is returned and `destination` is left alone.
    fn download(&self, path: &str, destination: &Path) -> Result<RemoteResponse, AppError>;
    /// `POST /api<path>` with the file at `file` as the body, carrying `name` (percent-encoded in
    /// `x-spm-file-name`), `content_type` and the declared length `size_bytes`.
    fn upload(
        &self,
        path: &str,
        name: &str,
        content_type: &str,
        file: &Path,
        size_bytes: u64,
    ) -> Result<RemoteResponse, AppError>;
}

/// The real [`RemoteLibrary`]: [`RemoteHost::proxy`], called from a blocking thread.
///
/// `Handle::block_on` must not be called from inside the runtime's own worker threads; every
/// caller is a `spawn_blocking` closure.
pub struct ProxyRemote {
    host: Arc<RemoteHost>,
    handle: tokio::runtime::Handle,
}

impl ProxyRemote {
    pub fn new(host: Arc<RemoteHost>, handle: tokio::runtime::Handle) -> ProxyRemote {
        ProxyRemote { host, handle }
    }
}

/// How much of an error body is read: the envelope is a few hundred bytes.
const MAX_ERROR_BODY: usize = 1024 * 1024;

fn api_path(path: &str) -> String {
    format!("/api{path}")
}

impl RemoteLibrary for ProxyRemote {
    fn origin(&self) -> &str {
        self.host.origin()
    }

    fn get(&self, path: &str) -> Result<RemoteResponse, AppError> {
        let request = Request::get(api_path(path))
            .body(Body::empty())
            .map_err(AppError::internal)?;
        self.handle.block_on(async {
            let response = self.host.proxy(request).await;
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
                .await
                .map_err(|error| {
                    AppError::internal(format!("could not read the answer: {error}"))
                })?;
            Ok(RemoteResponse {
                status,
                body: body.to_vec(),
            })
        })
    }

    fn download(&self, path: &str, destination: &Path) -> Result<RemoteResponse, AppError> {
        let request = Request::get(api_path(path))
            .body(Body::empty())
            .map_err(AppError::internal)?;
        self.handle.block_on(async {
            let response = self.host.proxy(request).await;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                let body = axum::body::to_bytes(response.into_body(), MAX_ERROR_BODY)
                    .await
                    .unwrap_or_default();
                return Ok(RemoteResponse {
                    status,
                    body: body.to_vec(),
                });
            }
            let mut file = std::fs::File::create(destination).map_err(AppError::internal)?;
            let mut stream = response.into_body().into_data_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| {
                    AppError::internal(format!("the download broke off: {error}"))
                })?;
                file.write_all(&chunk).map_err(AppError::internal)?;
            }
            file.flush().map_err(AppError::internal)?;
            Ok(RemoteResponse {
                status,
                body: Vec::new(),
            })
        })
    }

    fn upload(
        &self,
        path: &str,
        name: &str,
        content_type: &str,
        file: &Path,
        size_bytes: u64,
    ) -> Result<RemoteResponse, AppError> {
        self.handle.block_on(async {
            let file = tokio::fs::File::open(file)
                .await
                .map_err(AppError::internal)?;
            let request = Request::post(api_path(path))
                .header("content-type", content_type)
                // The name travels percent-encoded: a header value is Latin-1 by the HTTP grammar
                // and a file name is not.
                .header("x-spm-file-name", percent_encode(name))
                // **Not optional, and leaving it off is a live 411.** The server needs the size
                // before it writes a byte, for the quota check; the proxy turns this header into
                // the real `content-length`.
                .header(UPLOAD_LENGTH_HEADER, size_bytes.to_string())
                .body(Body::from_stream(ReaderStream::new(file)))
                .map_err(AppError::internal)?;
            let response = self.host.proxy(request).await;
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), MAX_ERROR_BODY)
                .await
                .unwrap_or_default();
            Ok(RemoteResponse {
                status,
                body: body.to_vec(),
            })
        })
    }
}

/// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()` is escaped.
pub fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The shell has no server. Not a failure of a request: there was never one to make.
pub fn require_remote(
    remote: Option<Arc<dyn RemoteLibrary>>,
) -> Result<Arc<dyn RemoteLibrary>, AppError> {
    remote.ok_or_else(|| AppError::conflict("this app is not connected to a server"))
}

/// The server's error envelope, turned back into an [`AppError`] with its own code (constraint 5).
///
/// The code is checked against the closed set rather than cast into it: it comes off the wire from
/// another machine, and an error carrying a code nothing switches on would be worse than an honest
/// `Internal`.
pub fn failure_of(response: &RemoteResponse, fallback: &str) -> AppError {
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let error = body.get("error");
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .and_then(AppErrorCode::parse)
        .unwrap_or(AppErrorCode::Internal);
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(fallback);
    let mut app_error = AppError::new(code, message);
    if let Some(details) = error
        .and_then(|error| error.get("details"))
        .and_then(Value::as_object)
        && !details.is_empty()
    {
        app_error = app_error.with_details(details.clone());
    }
    app_error
}

/// One file of a project, as a server reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    pub id: String,
    pub name: String,
    pub kind: FileKind,
    pub slicer: Option<SlicerId>,
}

/// The project as the server sees it, which is also the ownership check.
///
/// Remote mode has no local index to resolve a `fileId` against, and the API exposes no
/// `GET /api/files/:id`: so this is where a launch learns the file's name, kind and slicer, and
/// where a `(fileId, projectId)` pair the page made up is refused. A project the user does not own
/// answers 404 and arrives here as `NotFound`, exactly as core's own scoping would in local mode.
pub fn remote_project(
    remote: &dyn RemoteLibrary,
    project_id: &str,
) -> Result<Vec<RemoteFile>, AppError> {
    let response = remote.get(&format!("/projects/{}", percent_encode(project_id)))?;
    if !response.is_ok() {
        return Err(failure_of(&response, "could not read that project"));
    }
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    // Checked rather than cast. A 200 carrying `{}` (a proxy's idea of an error page, a server this
    // app is not actually talking to) is a sentence, not a malformed-JSON panic dressed as one.
    // This is the shallowest possible check; the one field this code goes on to *use* from a file
    // is its name, validated at the call site.
    let (Some(_), Some(files)) = (
        body.get("id").and_then(Value::as_str),
        body.get("files").and_then(Value::as_array),
    ) else {
        return Err(AppError::new(
            AppErrorCode::Internal,
            "that server did not answer with a project",
        ));
    };
    Ok(files
        .iter()
        .filter_map(|file| {
            Some(RemoteFile {
                id: file.get("id")?.as_str()?.to_owned(),
                name: file.get("name")?.as_str()?.to_owned(),
                kind: FileKind::parse(file.get("kind")?.as_str()?)?,
                slicer: file
                    .get("slicer")
                    .and_then(Value::as_str)
                    .and_then(SlicerId::parse),
            })
        })
        .collect())
}

/// Streams `/api/files/<id>/raw` into `destination`. Streamed rather than buffered because a model
/// part in the reference library reaches 674 MB. The caller removes the partial file, because only
/// the caller knows whether the directory it is in should survive.
pub fn remote_download(
    remote: &dyn RemoteLibrary,
    file_id: &str,
    destination: &Path,
) -> Result<(), AppError> {
    let response = remote.download(
        &format!("/files/{}/raw", percent_encode(file_id)),
        destination,
    )?;
    if !response.is_ok() {
        return Err(failure_of(&response, "could not download that file"));
    }
    Ok(())
}

/// Uploads a file from the launch directory to a project on the server, as a new file.
pub fn remote_upload(
    remote: &dyn RemoteLibrary,
    project_id: &str,
    name: &str,
    file: &Path,
    size_bytes: u64,
    content_type: &str,
) -> Result<Value, AppError> {
    let response = remote.upload(
        &format!("/projects/{}/files", percent_encode(project_id)),
        name,
        content_type,
        file,
        size_bytes,
    )?;
    if !response.is_ok() {
        return Err(failure_of(&response, &format!("could not upload {name}")));
    }
    serde_json::from_slice(&response.body).map_err(|_| {
        AppError::new(
            AppErrorCode::Internal,
            "that server did not answer with a file",
        )
    })
}
