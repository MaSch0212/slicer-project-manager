//! Serving the web bundle: files by path, falling back to `index.html` so client routes
//! deep-link.
//!
//! Where the bytes come from is an [`Assets`] source: a directory on disk (`SPM_WEB_ROOT`), a set
//! of files compiled into the binary, or anything else a host provides. The lookup and the
//! content types are the same for all of them.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use spm_core::files::paths::safe_join;
use spm_core::{AppError, content_type_for};

use crate::percent::try_decode_uri_component;

/// A read-only set of bundle files, addressed by a `/`-separated path relative to the bundle root
/// (`index.html`, `assets/app.js`).
pub trait Assets: Send + Sync + 'static {
    /// The file's bytes, or `None` when there is no such file. A path the source refuses (one
    /// that escapes its root, say) is also `None`: both collapse to the same answer, the SPA
    /// fallback.
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>>;
}

/// A bundle in a directory on disk.
#[derive(Debug, Clone)]
pub struct DirAssets {
    root: PathBuf,
}

impl DirAssets {
    /// `root` is used as given; a caller wanting cwd-relative semantics makes it absolute first
    /// (see `std::path::absolute`).
    pub fn new(root: impl Into<PathBuf>) -> DirAssets {
        DirAssets { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Assets for DirAssets {
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        let file = static_file_path(&self.root, path).ok()?;
        std::fs::read(file).ok().map(Cow::Owned)
    }
}

/// Joins a request-derived candidate under the web root, refusing anything that escapes it.
///
/// The guarantee is stated here, by core's own `safe_join` (the function every library path goes
/// through), rather than resting on the incidental fact that a client normalises dot segments
/// before sending. Fails with `Forbidden` on an absolute, empty or escaping segment.
pub fn static_file_path(root: &Path, candidate: &str) -> Result<PathBuf, AppError> {
    let segments: Vec<&str> = candidate.split('/').collect();
    safe_join(root, &segments)
}

/// The types the web bundle needs that core's `content_type_for` does not know.
///
/// **Here and not in core, on purpose.** `content_type_for` is the map for *library* files, bytes
/// a user dropped into a project folder under a name they chose. `svg` is precisely the entry that
/// would be unsafe there: an SVG document commits and can run script, which is why core's map does
/// not contain it. This map serves only the bundle's own output, where every file is one this
/// repository generated. Without these entries `favicon.svg`, `favicon.ico` and
/// `manifest.webmanifest` come back as `application/octet-stream`: Chromium does not sniff SVG for
/// an `<img>` and refuses a manifest that is not JSON.
pub fn bundle_content_type(path: &str) -> &'static str {
    let extension = path
        .rfind('.')
        .map(|dot| path[dot..].to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        ".css" => "text/css; charset=utf-8",
        ".html" => "text/html; charset=utf-8",
        ".ico" => "image/vnd.microsoft.icon",
        ".js" => "text/javascript; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".webmanifest" => "application/manifest+json",
        _ => content_type_for(path),
    }
}

/// Answers a non-API request from `assets`: the file at the request path, else `index.html`, else
/// a plain 404 (only a bundle with no `index.html` gets there).
pub async fn serve_assets(assets: &Arc<dyn Assets>, request_path: &str) -> Response {
    let relative = if request_path == "/" {
        "index.html".to_owned()
    } else {
        // A path that is not correctly percent-encoded is just a miss, like any other.
        try_decode_uri_component(request_path.trim_start_matches('/')).unwrap_or_default()
    };
    let assets = Arc::clone(assets);
    let found = tokio::task::spawn_blocking(move || {
        [relative.as_str(), "index.html"]
            .into_iter()
            .find_map(|candidate| {
                if candidate.is_empty() {
                    return None;
                }
                assets
                    .get(candidate)
                    .map(|bytes| (bundle_content_type(candidate), bytes))
            })
    })
    .await
    .ok()
    .flatten();
    match found {
        Some((content_type, bytes)) => {
            let mut response = Response::new(Body::from(bytes.into_owned()));
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
            response
        }
        None => not_found(),
    }
}

pub(crate) fn not_found() -> Response {
    let mut response = Response::new(Body::from("not found"));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use spm_core::AppErrorCode;
    use std::fs;

    fn dir_assets(root: &Path) -> Arc<dyn Assets> {
        Arc::new(DirAssets::new(root))
    }

    async fn body_text(response: Response) -> String {
        String::from_utf8(
            to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn static_file_path_refuses_any_candidate_that_escapes_the_web_root() {
        let root = std::env::temp_dir().join("spm-static-root");
        assert_eq!(
            static_file_path(&root, "index.html").unwrap(),
            std::path::absolute(&root).unwrap().join("index.html")
        );
        assert_eq!(
            static_file_path(&root, "assets/app.js").unwrap(),
            std::path::absolute(&root)
                .unwrap()
                .join("assets")
                .join("app.js")
        );
        for bad in [
            "../../../secrets.env",
            "assets/../../secrets.env",
            "/etc/passwd",
        ] {
            let error = static_file_path(&root, bad).unwrap_err();
            assert_eq!(error.code, AppErrorCode::Forbidden, "{bad}");
        }
    }

    #[tokio::test]
    async fn serves_files_and_falls_back_to_index_html_for_client_routes() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("root");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("index.html"), "<!doctype html>root").unwrap();
        fs::write(root.join("assets").join("app.js"), "console.log(1)").unwrap();
        fs::write(scratch.path().join("secret.txt"), "do not serve me").unwrap();
        let assets = dir_assets(&root);

        let index = serve_assets(&assets, "/").await;
        assert_eq!(index.status(), 200);
        assert_eq!(index.headers()[CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(body_text(index).await, "<!doctype html>root");

        let asset = serve_assets(&assets, "/assets/app.js").await;
        assert_eq!(asset.status(), 200);
        assert_eq!(
            asset.headers()[CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );

        let deep_link = serve_assets(&assets, "/projects/abc").await;
        assert_eq!(deep_link.status(), 200);
        assert_eq!(body_text(deep_link).await, "<!doctype html>root");

        // A refused candidate is not a 500: it falls through to the SPA fallback like any miss,
        // including the encoded forms a client could send and the malformed one.
        for traversal in [
            "/%2e%2e/secret.txt",
            "/..%2fsecret.txt",
            "/assets/%2e%2e/%2e%2e/secret.txt",
            "/%",
        ] {
            let response = serve_assets(&assets, traversal).await;
            assert_eq!(response.status(), 200, "{traversal}");
            assert_eq!(
                body_text(response).await,
                "<!doctype html>root",
                "{traversal}"
            );
        }

        // A percent-encoded name is decoded before the lookup.
        fs::write(root.join("my file.txt"), "spaced").unwrap();
        let spaced = serve_assets(&assets, "/my%20file.txt").await;
        assert_eq!(body_text(spaced).await, "spaced");

        // The only 404 left: a root that exists but has no index.html.
        let empty = scratch.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        let missing = serve_assets(&dir_assets(&empty), "/").await;
        assert_eq!(missing.status(), 404);
    }

    #[tokio::test]
    async fn the_icon_assets_are_served_as_themselves_not_as_octet_stream() {
        let scratch = tempfile::tempdir().unwrap();
        fs::write(scratch.path().join("index.html"), "<!doctype html>root").unwrap();
        let names = [
            "favicon.svg",
            "favicon.ico",
            "manifest.webmanifest",
            "icon-192.png",
        ];
        for name in names {
            fs::write(scratch.path().join(name), "x").unwrap();
        }
        let assets = dir_assets(scratch.path());
        let mut types = Vec::new();
        for name in names {
            let response = serve_assets(&assets, &format!("/{name}")).await;
            types.push(
                response.headers()[CONTENT_TYPE]
                    .to_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        assert_eq!(
            types,
            [
                "image/svg+xml",
                "image/vnd.microsoft.icon",
                "application/manifest+json",
                // Already right through core's map; here so a lookup that dropped the fallback to
                // `content_type_for` fails instead of passing.
                "image/png",
            ]
        );
        // Core's map must not learn `svg`: it serves files a user chose the name of, and an SVG
        // document can run script.
        assert_eq!(content_type_for("drawing.svg"), "application/octet-stream");
        assert_eq!(
            content_type_for("anything.webmanifest"),
            "application/octet-stream"
        );
    }

    #[test]
    fn content_types_ignore_case_and_unknown_extensions() {
        assert_eq!(
            bundle_content_type("A.JS"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(bundle_content_type("noext"), "application/octet-stream");
        assert_eq!(bundle_content_type("x.woff2"), "application/octet-stream");
    }
}
