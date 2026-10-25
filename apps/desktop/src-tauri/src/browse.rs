//! The model browser's child webview: the glue between `spm_shell::browse` (which owns every
//! decision) and Tauri's multiwebview API (`Window::add_child`, Cargo feature `unstable`).
//!
//! # The view
//!
//! A child webview of the **main window**, labelled [`BROWSE_WEBVIEW`], on its own
//! `data_directory` (`<data dir>/browse-profile`, persistent: the user signs in to a site once).
//! It is not the main webview and it is never named by [`crate::security::main_capability`]:
//! Tauri injects its bridge into every page a webview loads, so what keeps a model site out of
//! the app's commands is the capability ACL alone, by label and by origin. The hidden smoke run
//! proves it from inside the view (see `hidden.rs`).
//!
//! The child **does not follow window resizes** (measured). The host positions it with
//! `set_bounds` from the page's reports and from the window's own `Resized` event, hides it for a
//! dialog, and destroys it when the route goes.
//!
//! # What the hooks do
//!
//! - `on_navigation`: the browse policy; a refused URL is recorded as the sentence the chrome
//!   shows. (Fires for top-level navigations and their redirects; WebView2 reports subframe
//!   navigations separately and Tauri does not expose them.)
//! - `on_new_window`: always `Deny`; an `http(s)`/`blob:`/`data:` target is routed into the view
//!   instead. No window is ever created.
//! - `on_download`: the decision is made inside the `Requested` arm (a `blob:` URL cannot be
//!   re-fetched) by redirecting `destination` into the staging directory.
//! - `on_permission_request`: everything denied.
//!
//! Every closure here runs on the main thread and takes `spm_shell::browse`'s small locks only; no
//! lock is held across a call back into the webview.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use spm_core::AppError;
use spm_shell::browse::bounds::Rect;
use spm_shell::browse::downloads::{Decision, DownloadRequest};
use spm_shell::browse::host::{BrowseView, HostWindow, ViewFactory};
use spm_shell::browse::service::BrowseServices;
use tauri::webview::{
    DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionResponse, WebviewBuilder,
};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Runtime, Size, Webview, WebviewUrl,
};

use crate::window::TitleSink;

/// The label of the browse child webview. **Never granted anything** (`security`).
pub const BROWSE_WEBVIEW: &str = "browse";

/// The persistent profile, beside `webview/` (the main webview's) under the data directory.
pub const BROWSE_PROFILE_DIR: &str = "browse-profile";

/// What the webview told us, which has no synchronous getter.
#[derive(Default)]
struct ViewMeta {
    title: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

/// The services, once they exist (the factory is built first because the services need it).
pub type ServicesCell = Arc<OnceLock<Arc<BrowseServices>>>;

pub struct TauriView<R: Runtime> {
    webview: Webview<R>,
    meta: Arc<Mutex<ViewMeta>>,
    closed: AtomicBool,
}

impl<R: Runtime> TauriView<R> {
    fn meta(&self) -> std::sync::MutexGuard<'_, ViewMeta> {
        self.meta.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// `navigation.canGoBack` and `.canGoForward` (the Navigation API; WebView2 is Chromium), as a
/// string the callback parses. A page that shadows `navigation` can only mis-enable two buttons.
const HISTORY_PROBE_JS: &str = "(() => { try { return JSON.stringify({ b: navigation.canGoBack, f: navigation.canGoForward }); } catch (e) { return 'null'; } })()";

impl<R: Runtime> BrowseView for TauriView<R> {
    fn load(&self, url: &str) -> Result<(), String> {
        let parsed: tauri::Url = url
            .parse()
            .map_err(|_| "that address is not a URL".to_owned())?;
        self.webview
            .navigate(parsed)
            .map_err(|error| error.to_string())
    }

    fn back(&self) {
        let _ = self.webview.eval("history.back()");
    }

    fn forward(&self) {
        let _ = self.webview.eval("history.forward()");
    }

    fn reload(&self) {
        let _ = self.webview.reload();
    }

    fn set_bounds(&self, rect: Rect) {
        let _ = self.webview.set_bounds(tauri::Rect {
            position: Position::Logical(LogicalPosition::new(rect.x, rect.y)),
            size: Size::Logical(LogicalSize::new(rect.width, rect.height)),
        });
    }

    fn set_visible(&self, visible: bool) {
        let _ = if visible {
            self.webview.show()
        } else {
            self.webview.hide()
        };
    }

    fn url(&self) -> Option<String> {
        self.webview.url().ok().map(|url| url.to_string())
    }

    fn title(&self) -> Option<String> {
        self.meta().title.clone()
    }

    fn is_loading(&self) -> bool {
        self.meta().loading
    }

    fn can_go_back(&self) -> bool {
        self.meta().can_go_back
    }

    fn can_go_forward(&self) -> bool {
        self.meta().can_go_forward
    }

    fn refresh(&self) {
        let meta = Arc::clone(&self.meta);
        let _ = self
            .webview
            .eval_with_callback(HISTORY_PROBE_JS, move |answer| {
                // The callback receives the script's value serialised once more: a JSON string.
                let Ok(inner) = serde_json::from_str::<String>(&answer) else {
                    return;
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&inner) else {
                    return;
                };
                let mut meta = meta.lock().unwrap_or_else(|e| e.into_inner());
                meta.can_go_back = value["b"] == true;
                meta.can_go_forward = value["f"] == true;
            });
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.webview.close();
    }

    fn is_alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
            && self
                .webview
                .app_handle()
                .get_webview(BROWSE_WEBVIEW)
                .is_some()
    }
}

/// Makes the child webview in the main window.
pub struct TauriViewFactory<R: Runtime> {
    pub app: AppHandle<R>,
    pub services: ServicesCell,
    pub profile_dir: PathBuf,
    /// The smoke run reads what the view's own pages report through the document title.
    pub title_sink: Option<TitleSink>,
}

fn logical(rect: Rect) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(rect.x, rect.y),
        LogicalSize::new(rect.width, rect.height),
    )
}

impl<R: Runtime> ViewFactory for TauriViewFactory<R> {
    fn create(&self, start_url: &str, rect: Option<Rect>) -> Result<Arc<dyn BrowseView>, AppError> {
        let window = self
            .app
            .get_window(crate::security::MAIN_WEBVIEW)
            .ok_or_else(|| AppError::conflict("there is no window to put a model browser in"))?;
        let url: tauri::Url = start_url
            .parse()
            .map_err(|_| AppError::validation("that URL cannot be opened in the model browser"))?;
        let meta = Arc::new(Mutex::new(ViewMeta::default()));

        let services = Arc::clone(&self.services);
        let on_navigation = move |url: &tauri::Url| {
            services
                .get()
                .is_none_or(|services| services.host().on_navigation(url.as_str()))
        };
        let services = Arc::clone(&self.services);
        let on_new_window = move |url: tauri::Url, _features| {
            if let Some(services) = services.get() {
                services.host().on_new_window(url.as_str());
            }
            NewWindowResponse::Deny
        };
        let services = Arc::clone(&self.services);
        let on_download = move |webview: Webview<R>, event: DownloadEvent<'_>| match event {
            DownloadEvent::Requested { url, destination } => {
                let Some(services) = services.get() else {
                    return false;
                };
                let file_name = destination
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                // WebView2 reports no content length, MIME type or user-gesture flag.
                let request = DownloadRequest {
                    file_name,
                    url: url.to_string(),
                    page_url: webview.url().ok().map(|url| url.to_string()),
                    mime_type: String::new(),
                    total_bytes: 0,
                    had_user_gesture: false,
                };
                match services.on_download_requested(&request) {
                    Decision::Stage(path) => {
                        *destination = path;
                        true
                    }
                    Decision::Refuse => false,
                }
            }
            DownloadEvent::Finished { url, path, success } => {
                if let Some(services) = services.get() {
                    services.on_download_finished(url.as_str(), path.as_deref(), success);
                }
                true
            }
            _ => true,
        };
        let page_meta = Arc::clone(&meta);
        let services = Arc::clone(&self.services);
        let on_page_load =
            move |_webview: Webview<R>, payload: tauri::webview::PageLoadPayload<'_>| {
                let started = matches!(payload.event(), PageLoadEvent::Started);
                page_meta.lock().unwrap_or_else(|e| e.into_inner()).loading = started;
                if !started && let Some(services) = services.get() {
                    services.host().on_committed(payload.url().as_str());
                }
            };
        let title_meta = Arc::clone(&meta);
        let sink = self.title_sink.clone();
        let on_title = move |webview: Webview<R>, title: String| {
            if let Some(sink) = &sink {
                sink(webview.label(), title.clone());
            }
            title_meta.lock().unwrap_or_else(|e| e.into_inner()).title = Some(title);
        };

        let builder = WebviewBuilder::new(BROWSE_WEBVIEW, WebviewUrl::External(url))
            .data_directory(self.profile_dir.clone())
            .on_navigation(on_navigation)
            .on_new_window(on_new_window)
            .on_download(on_download)
            .on_page_load(on_page_load)
            .on_document_title_changed(on_title)
            // Everything refused, without a prompt a user could be talked into accepting.
            .on_permission_request(|_webview, _kind| PermissionResponse::Deny)
            .focused(false);
        let hidden_at_birth = rect.is_none();
        let (position, size) = logical(rect.unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }));
        let webview = window
            .add_child(builder, position, size)
            .map_err(AppError::internal)?;
        if hidden_at_birth {
            let _ = webview.hide();
        }
        Ok(Arc::new(TauriView {
            webview,
            meta,
            closed: AtomicBool::new(false),
        }))
    }
}

/// The main window, as the host sizes the view against it.
pub struct TauriWindow<R: Runtime> {
    pub app: AppHandle<R>,
}

impl<R: Runtime> HostWindow for TauriWindow<R> {
    /// Logical pixels: the child is positioned in them, and a CSS pixel of the unzoomed page is one.
    fn content_size(&self) -> Option<(f64, f64)> {
        let window = self.app.get_window(crate::security::MAIN_WEBVIEW)?;
        let scale = window.scale_factor().ok()?;
        let size = window.inner_size().ok()?;
        Some((
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        ))
    }

    fn zoom(&self) -> f64 {
        1.0
    }
}
