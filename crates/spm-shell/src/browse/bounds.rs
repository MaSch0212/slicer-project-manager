//! The rectangle the browse view is allowed, which **the shell computes and the page never names**.
//!
//! The view is a native sibling of the page, not an element in it: it paints over whatever the page
//! draws under its rectangle, and CSS cannot lay it out. The page reports where its placeholder is
//! (an *intent*, in CSS pixels); the shell intersects that with an area it works out for itself.
//!
//! **Not "clamped to the window"**, which would be the whole window and so no defence at all. The
//! shell reserves the app's chrome band itself ([`CHROME_INSET`]): the sidebar's width on the left
//! and the page header and the browser's own controls on top. The page cannot widen the allowed
//! area because it never names it, and a hostile or buggy page can therefore not put a site over
//! the app's own controls.
//!
//! **A minimum area, for the reverse attack.** A page that reports `1x1` would keep a live
//! third-party page running invisibly, so a request that intersects to less than
//! [`MIN_AREA`] is no rectangle at all and the view is hidden instead.

use spm_core::dto::BrowseBounds;

/// What the shell keeps for the app's own chrome, in CSS pixels. A judgement: the collapsed
/// sidebar is 64 px wide and the page header plus the browser's controls are well over 100 px
/// tall, so the real placeholder is always inside what is left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Inset {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

pub const CHROME_INSET: Inset = Inset {
    top: 100.0,
    right: 0.0,
    bottom: 0.0,
    left: 64.0,
};

/// The smallest area worth painting a page in, in CSS pixels, per dimension.
pub const MIN_AREA: (f64, f64) = (200.0, 200.0);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The rectangle to give the view, or `None` when it should be hidden.
///
/// `content` is the window's content size in device pixels and `zoom` the factor between a CSS
/// pixel and a device pixel; the request, the inset and the minimum are all CSS pixels and are
/// converted together, so the property holds at any zoom. A request that is not a rectangle (a
/// `NaN`, an infinity, a zero or negative zoom) is no rectangle rather than an exception.
pub fn view_bounds(
    request: &BrowseBounds,
    content: (f64, f64),
    zoom: f64,
    inset: Inset,
    minimum: (f64, f64),
) -> Option<Rect> {
    let numbers = [
        request.x,
        request.y,
        request.width,
        request.height,
        content.0,
        content.1,
        zoom,
    ];
    if !numbers.iter().all(|value| value.is_finite()) || zoom <= 0.0 {
        return None;
    }
    let content_width = content.0 / zoom;
    let content_height = content.1 / zoom;
    let left = request.x.max(inset.left);
    let top = request.y.max(inset.top);
    let right = (request.x + request.width).min(content_width - inset.right);
    let bottom = (request.y + request.height).min(content_height - inset.bottom);
    let width = right - left;
    let height = bottom - top;
    if width < minimum.0 || height < minimum.1 {
        return None;
    }
    Some(Rect {
        x: (left * zoom).round(),
        y: (top * zoom).round(),
        width: (width * zoom).round(),
        height: (height * zoom).round(),
    })
}
