//! A still picture of a browse tab, for the dialog that is drawn over it.
//!
//! The view is a native sibling of the page and paints over everything the page draws, so a
//! modal has to hide it — and hiding it alone would leave a hole where the site was. The answer
//! is to put a picture of the view in the hole first. `spm_win32` takes the picture (the only
//! `unsafe` in the app); this is the bridge from Tauri's webview to it, and the wait.

use std::sync::mpsc;
use std::time::Duration;

use tauri::{Runtime, Webview};

/// How long to wait for the picture before giving up on it.
///
/// A capture is an improvement on the dialog, never a requirement of it: past this the dialog
/// opens against the empty slot, which is what it used to do every time. Short enough that a
/// slow capture cannot turn pressing a button into a visible stall.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_millis(350);

/// A PNG of what this webview is showing, or `None`.
///
/// **Never call this on the main thread.** `with_webview` runs its closure there and the
/// completion runs there too, so a main-thread caller would be waiting for work it is itself
/// blocking. Every caller is a `desktop_browse_*` command, which Tauri runs off it.
pub fn capture_webview_png<R: Runtime>(webview: &Webview<R>) -> Option<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    let posted = webview.with_webview(move |platform| {
        #[cfg(windows)]
        {
            spm_win32::capture_png(platform.controller().clone(), move |png| {
                let _ = sender.send(png);
            });
        }
        #[cfg(not(windows))]
        {
            let _ = platform;
            let _ = sender.send(None);
        }
    });
    if posted.is_err() {
        return None;
    }
    receiver.recv_timeout(CAPTURE_TIMEOUT).ok().flatten()
}
