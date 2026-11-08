//! A PNG of what a WebView2 is showing.
//!
//! WebView2's own `CapturePreview` is the only way to get the pixels of a webview that is a
//! native sibling of the page: nothing the page can draw sees them, and a screen grab of the
//! window would catch whatever is in front of it. It is asynchronous and its completion runs on
//! the thread that owns the webview, so this hands the bytes back through a callback rather than
//! returning them; the caller waits on its own thread, never on this one.

use std::cell::RefCell;
use std::rc::Rc;

use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, ICoreWebView2Controller,
};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

/// Takes the picture and calls `done` with the PNG, or with `None` if anything at all went
/// wrong. **Call it on the thread that owns the webview**; `done` runs on that thread too.
///
/// Never panics and never reports an error: a capture is an improvement on the dialog, not a
/// requirement of it, so every failure is simply no picture.
pub fn capture_png<F>(controller: ICoreWebView2Controller, done: F)
where
    F: FnOnce(Option<Vec<u8>>) + 'static,
{
    // `RefCell<Option<_>>` because the COM handler's closure is `FnOnce` but the type system
    // cannot see that it runs once: taking it out is what makes calling `done` once provable.
    let done = Rc::new(RefCell::new(Some(done)));
    let fallback = Rc::clone(&done);
    if start(controller, done).is_err()
        && let Some(done) = fallback.borrow_mut().take()
    {
        done(None);
    }
}

fn start<F>(
    controller: ICoreWebView2Controller,
    done: Rc<RefCell<Option<F>>>,
) -> windows::core::Result<()>
where
    F: FnOnce(Option<Vec<u8>>) + 'static,
{
    // SAFETY: `controller` is a live `ICoreWebView2Controller` — the caller holds a reference
    // counted handle to it, which is what having the typed value means — and `CoreWebView2` only
    // reads from it. Called on the owning thread, as the module docs require.
    let webview = unsafe { controller.CoreWebView2() }?;

    // SAFETY: a null `HGLOBAL` asks the system to allocate one that grows as it is written, and
    // `true` makes the returned stream own it and free it when the last reference goes. We hold
    // the only references (here and in the handler), so nothing outlives the memory.
    let stream: IStream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }?;

    let for_handler = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let bytes = result.ok().and_then(|()| read_all(&for_handler));
        if let Some(done) = done.borrow_mut().take() {
            done(bytes);
        }
        Ok(())
    }));

    // SAFETY: both arguments outlive the call — `stream` is owned here and the handler holds its
    // own reference to the same object, and `handler` is a COM object whose lifetime WebView2
    // takes a reference to. The completion runs on this thread.
    unsafe {
        webview.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    }
}

/// Everything written to a stream backed by an `HGLOBAL`, copied out as a `Vec`.
fn read_all(stream: &IStream) -> Option<Vec<u8>> {
    // SAFETY: the stream was made by `CreateStreamOnHGlobal`, which is exactly the case
    // `GetHGlobalFromStream` is for; it only reads the stream's own handle.
    let handle = unsafe { GetHGlobalFromStream(stream) }.ok()?;

    // SAFETY: `handle` came from the call above and is still owned by `stream`, which is alive
    // for the whole of this function.
    let size = unsafe { GlobalSize(handle) };
    if size == 0 {
        return None;
    }

    // SAFETY: as above. `GlobalLock` answers null on failure, which is checked before the
    // pointer is read.
    let pointer = unsafe { GlobalLock(handle) } as *const u8;
    if pointer.is_null() {
        return None;
    }
    // SAFETY: `GlobalLock` pins `size` bytes at `pointer` until the matching `GlobalUnlock`,
    // which happens below and on no other path: the slice is read and copied before then, and
    // nothing in between can reallocate the block (this thread owns it and makes no COM call).
    let bytes = unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec();
    // SAFETY: pairs with the `GlobalLock` above, on the same handle.
    unsafe {
        let _ = GlobalUnlock(handle);
    }
    Some(bytes)
}
