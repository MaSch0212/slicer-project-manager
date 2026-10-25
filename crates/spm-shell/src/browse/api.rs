//! The library API as the model browser reaches it, **in both library modes through one path**.
//!
//! A landing is `POST /api/projects/<id>/files` and a match is `GET /api/projects`, made against
//! the app's own API: in local mode the same `spm-http` router the loopback listener serves (called
//! in process, so no launch secret is needed and none is exposed), in remote mode the reverse
//! proxy that holds the session cookie. Both arrive as a [`RemoteLibrary`], the seam the slicer
//! subsystem already uses, so `remote_upload` is the one upload and the quota check, the name
//! clash and every other rule are the server's, not a second copy of them here.
//!
//! **The bytes never cross IPC.** The page names a download id and a project id; the file is
//! streamed from the staging directory straight into the request.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use futures_util::StreamExt;
use spm_core::AppError;
use tokio_util::io::ReaderStream;
use tower::ServiceExt;

use crate::shell::Shell;
use crate::slicers::remote_files::{ProxyRemote, RemoteLibrary, RemoteResponse, percent_encode};

/// Resolves the library the shell is on **now** (the user may switch folder or server between two
/// calls), or says there is none.
pub type LibrarySource = Arc<dyn Fn() -> Result<Arc<dyn RemoteLibrary>, AppError> + Send + Sync>;

/// How much of a body is read back: an error envelope or a project list.
const MAX_BODY: usize = 64 * 1024 * 1024;

/// The local library's router, called in process, as a [`RemoteLibrary`].
pub struct LocalApi {
    router: Router,
    handle: tokio::runtime::Handle,
}

impl LocalApi {
    pub fn new(router: Router, handle: tokio::runtime::Handle) -> LocalApi {
        LocalApi { router, handle }
    }

    fn call(&self, request: Request<Body>) -> Result<(u16, Body), AppError> {
        let router = self.router.clone();
        self.handle.block_on(async move {
            match router.oneshot(request).await {
                Ok(response) => Ok((response.status().as_u16(), response.into_body())),
                Err(never) => match never {},
            }
        })
    }
}

impl RemoteLibrary for LocalApi {
    fn origin(&self) -> &str {
        "local"
    }

    fn get(&self, path: &str) -> Result<RemoteResponse, AppError> {
        let request = Request::get(format!("/api{path}"))
            .body(Body::empty())
            .map_err(AppError::internal)?;
        let (status, body) = self.call(request)?;
        let body = self
            .handle
            .block_on(axum::body::to_bytes(body, MAX_BODY))
            .map_err(AppError::internal)?;
        Ok(RemoteResponse {
            status,
            body: body.to_vec(),
        })
    }

    fn download(&self, path: &str, destination: &Path) -> Result<RemoteResponse, AppError> {
        let request = Request::get(format!("/api{path}"))
            .body(Body::empty())
            .map_err(AppError::internal)?;
        let (status, body) = self.call(request)?;
        if !(200..300).contains(&status) {
            let body = self
                .handle
                .block_on(axum::body::to_bytes(body, MAX_BODY))
                .unwrap_or_default();
            return Ok(RemoteResponse {
                status,
                body: body.to_vec(),
            });
        }
        self.handle.block_on(async {
            let mut file = std::fs::File::create(destination).map_err(AppError::internal)?;
            let mut stream = body.into_data_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(AppError::internal)?;
                file.write_all(&chunk).map_err(AppError::internal)?;
            }
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
        let file = self
            .handle
            .block_on(tokio::fs::File::open(file))
            .map_err(AppError::internal)?;
        let request = Request::post(format!("/api{path}"))
            .header("content-type", content_type)
            .header("x-spm-file-name", percent_encode(name))
            // The server needs the size before it writes a byte, for the quota check.
            .header("content-length", size_bytes.to_string())
            .body(Body::from_stream(ReaderStream::new(file)))
            .map_err(AppError::internal)?;
        let (status, body) = self.call(request)?;
        let body = self
            .handle
            .block_on(axum::body::to_bytes(body, MAX_BODY))
            .unwrap_or_default();
        Ok(RemoteResponse {
            status,
            body: body.to_vec(),
        })
    }
}

/// The library the shell is on, per call: the server's proxy in remote mode, the local router in
/// local mode, `Conflict` with nothing open.
pub fn library_source_for_shell(
    shell: &Arc<Shell>,
    handle: tokio::runtime::Handle,
) -> LibrarySource {
    let shell = Arc::clone(shell);
    Arc::new(move || {
        if let Some(remote) = shell.remote() {
            return Ok(Arc::new(ProxyRemote::new(remote, handle.clone())) as Arc<dyn RemoteLibrary>);
        }
        match shell.local_router() {
            Some(router) => {
                Ok(Arc::new(LocalApi::new(router, handle.clone())) as Arc<dyn RemoteLibrary>)
            }
            None => Err(AppError::conflict("no library folder is open")),
        }
    })
}
