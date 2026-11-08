//! The Windows calls the desktop app cannot make safely, behind safe functions.
//!
//! **This is the only crate in the workspace without `unsafe_code = "forbid"`.** It exists so
//! that the one place that needs `unsafe` is one small, reviewable crate rather than an exception
//! sprinkled through the app. Everything here:
//!
//! - takes and returns plain Rust values, never a raw pointer or a handle;
//! - is a no-op returning `None` or `Ok(())` off Windows, so callers need no `cfg`;
//! - documents, at each `unsafe` block, what makes it sound.
//!
//! Nothing here is allowed to panic on a bad answer from the system: a capture that cannot be
//! taken is `None`, which the caller already has to handle.

#[cfg(windows)]
mod capture;

#[cfg(windows)]
pub use capture::capture_png;

/// The controller type, re-exported so a caller can name it without depending on `webview2-com`
/// itself. It is the same type Tauri's `PlatformWebview::controller()` hands out; if the two
/// ever resolved to different versions of the crate, that would be a compile error here rather
/// than a silent mismatch.
#[cfg(windows)]
pub use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;

/// There is no WebView2 off Windows, so there is nothing to capture. The signature only has to
/// let the caller compile; it answers at once, with no picture.
#[cfg(not(windows))]
pub fn capture_png<F>(_controller: (), done: F)
where
    F: FnOnce(Option<Vec<u8>>) + 'static,
{
    done(None);
}

/// Stands in for the controller type off Windows, so the caller needs no `cfg` of its own.
#[cfg(not(windows))]
pub type ICoreWebView2Controller = ();
