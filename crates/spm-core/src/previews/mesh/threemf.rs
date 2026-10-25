//! The mesh geometry of a 3MF, streamed out of the zip entry that holds it.
//!
//! The model part of a real 3MF is routinely hundreds of megabytes (674 MB for the three largest
//! files in the reference library), so it is **never inflated whole**: the entry is pulled in
//! 64 KB chunks through the inflater, copied into one fixed 256 KB window, scanned, and the window
//! compacted down to the earliest byte any cursor still needs. Peak is that window, plus the mesh
//! arrays, plus the inflater's own few kilobytes, and none of the three is a function of the model
//! part's size.
//!
//! # A byte scan, not an XML parser
//!
//! The scan walks the inflated bytes for the three element starts it needs (`<mesh`, `<vertex`,
//! `<triangle`) and for comments, and reads attributes straight out of the bytes of one tag. It
//! never decodes the document to text. That is exact rather than approximate: every element and
//! attribute name in the 3MF core schema is ASCII, and UTF-8 is self-synchronising (a byte below
//! 0x80 only ever appears as itself, never inside a multi-byte sequence), so an ASCII needle can
//! never match the interior of a non-ASCII character. Non-ASCII bytes can only occur in attribute
//! *values* or text, which the marker search does not inspect.
//!
//! Assumes the default (unprefixed) 3MF core XML namespace. A namespace-prefixed producer
//! (`<m:vertex>`) yields no geometry from this scan and fails cleanly with "3MF model has no
//! triangles" rather than being handled: an accepted gap for the 3MF *core* format.

use std::path::Path;

use serde_json::{Map, Value};

use super::Mesh;
use super::jsnum::{is_integer, js_number};
use super::limits::{MeshLimits, allocate_mesh, assert_mesh_fits};
use crate::error::{AppError, Result};
use crate::files::chunks::{ChunkSink, drain_sink};
use crate::files::zip::{ZipChunkOptions, find_zip_entry, open_zip};

const MODEL_ENTRY_NAME: &str = "3D/3dmodel.model";

/// How many bytes of the model part are held at once.
///
/// This is the *whole* of the parser's document-side memory. Chosen an order of magnitude above
/// the largest thing that has to fit in it whole (one tag), so that the compaction after each scan
/// moves a few dozen bytes rather than most of the buffer, while staying noise next to a 100 MB
/// mesh. Comments are *not* bound by it: a comment whose close has not arrived is scanned a window
/// at a time and then thrown away except for the two bytes a straddling `-->` could need, so a
/// multi-megabyte comment costs scanning and no memory.
pub const WINDOW_BYTES: usize = 256 * 1024;

/// The chunk size asked of the zip reader. Only a loop-granularity knob: every chunk is copied
/// into the window and dropped.
const ZIP_CHUNK_BYTES: usize = 64 * 1024;

/// How close to the end of a window a marker may start and still be acted on.
///
/// `<triangle` is the longest marker at 9 bytes, and the tag search reads the byte *after* the
/// name to insist on real XML whitespace, so the last 10 bytes of a window are a place where a
/// marker may be present but unrecognisable. Anything found at or after `len - this` is left for
/// the next window, and so is anything *not* found, since absence is only proven below that line.
/// Too small and the scan silently drops the geometry that straddles a window boundary.
const MARKER_LOOKAHEAD: usize = 10;

/// A byte sequence to search for, plus the index of the byte the search anchors on.
struct Marker {
    bytes: &'static [u8],
    anchor: usize,
}

// Each marker anchors on a byte chosen to be absent from the *other* elements, not on its first
// byte. Anchoring four of these five on `<` (the commonest byte in an XML document) would have a
// cursor crossing a long stretch of the wrong element stop and compare at every tag on the way;
// with a byte the other element does not contain, that stretch is one `memchr` and nothing more.
// `x` never appears in `<triangle v1=... v2=... v3=.../>`, `g` never appears in
// `<vertex x=... y=... z=.../>`, and neither `h` nor `!` appears in either.
const MESH_TAG: Marker = Marker {
    bytes: b"<mesh",
    anchor: 4, // 'h'
};
const COMMENT_START: Marker = Marker {
    bytes: b"<!--",
    anchor: 1, // '!'
};
const COMMENT_END: Marker = Marker {
    bytes: b"-->",
    anchor: 2, // '>', rather than a '-' that every negative coordinate has
};
const VERTEX_MARKER: Marker = Marker {
    bytes: b"<vertex",
    anchor: 6, // 'x'
};
const TRIANGLE_MARKER: Marker = Marker {
    bytes: b"<triangle",
    anchor: 6, // 'g'
};
const GT: u8 = b'>';

const fn is_xml_whitespace(byte: u8) -> bool {
    matches!(byte, 0x20 | 0x09 | 0x0d | 0x0a)
}

/// What a test can observe about one parse. Not part of the API: `bytes_walked` is how a test
/// proves the scan is linear, `peak_window_bytes` that its buffer is fixed, and `before_fill` is
/// the seam that lets a test change the file between the two passes.
#[doc(hidden)]
#[derive(Default)]
pub struct ScanProbe {
    /// Bytes crossed by every `memchr` of every search, over both passes.
    pub bytes_walked: u64,
    /// The most bytes the window ever held.
    pub peak_window_bytes: usize,
    /// Called after the counting pass and before the filling pass.
    pub before_fill: Option<Box<dyn FnMut()>>,
}

/// `memchr` for a marker. Finds the marker's anchor byte with `memchr` (one SIMD scan rather than
/// a loop over every position) and only then compares the rest, so a near-miss costs one byte
/// comparison. Each call resumes from `from` and never rescans behind it, which is what keeps the
/// caller's cursors linear.
fn index_of_bytes(bytes: &[u8], needle: &Marker, from: usize, walked: &mut u64) -> Option<usize> {
    let pattern = needle.bytes;
    let target = pattern[needle.anchor];
    let last_start = bytes.len().checked_sub(pattern.len())?;
    // The anchor byte can only be at or after `from + anchor`, since the match itself starts at or
    // after `from`. Probing from there also keeps the search monotonic.
    let mut probe = from + needle.anchor;
    loop {
        if probe >= bytes.len() {
            return None;
        }
        let tail = &bytes[probe..];
        let Some(found) = memchr::memchr(target, tail) else {
            *walked += tail.len() as u64;
            return None;
        };
        *walked += found as u64;
        probe += found;
        let start = probe - needle.anchor;
        // `probe` only ever increases, so once the implied start is past the last possible one
        // there is nothing further to find.
        if start > last_start {
            return None;
        }
        if &bytes[start..start + pattern.len()] == pattern {
            return Some(start);
        }
        probe += 1;
    }
}

/// Finds the next `<name ...>` element start at or after `from`, requiring real XML whitespace
/// right after the element name rather than a literal space: a pretty-printer that wraps a long
/// attribute list onto its own line is still recognised, where a search for `<vertex ` would see
/// no marker and silently skip the element.
///
/// At the very end of a window the byte after the name may simply not have arrived yet, and this
/// cannot tell that apart from a false start, which is why [`MARKER_LOOKAHEAD`] exists and why
/// nothing found in that tail is trusted either way.
fn index_of_tag(bytes: &[u8], needle: &Marker, from: usize, walked: &mut u64) -> Option<usize> {
    let mut at = from;
    loop {
        at = index_of_bytes(bytes, needle, at, walked)?;
        if bytes
            .get(at + needle.bytes.len())
            .is_some_and(|byte| is_xml_whitespace(*byte))
        {
            return Some(at);
        }
        at += needle.bytes.len();
    }
}

/// The three things the scan reports, in document order.
trait ModelVisitor {
    fn mesh(&mut self);
    /// Called with one tag, from its `<` up to and including its `>`.
    fn vertex(&mut self, tag: &[u8]) -> Result<()>;
    fn triangle(&mut self, tag: &[u8]) -> Result<()>;
}

/// What one pass over one window found, and where the next window has to start.
struct WindowScan {
    /// Bytes the caller may discard. Everything from here on is still needed.
    consumed_to: usize,
    /// `consumed_to` points at a `<!--` whose `-->` is not in this window; skip to past it.
    entered_comment: bool,
}

/// Walks one window of 3MF model XML, calling back for each `<mesh>` boundary, `<vertex>` tag and
/// `<triangle>` tag in document order, skipping anything inside an XML comment: a commented-out
/// element must not be ingested as real geometry (it would silently shift every later local
/// vertex index by one). Shared between the counting and filling passes so both agree exactly on
/// what counts as geometry; their comment handling cannot drift apart because there is one copy.
///
/// No DOM, no whole-document string, and no regex: `memchr`-based cursors are cached per marker
/// kind and only ever advanced forward. **Within a window** that makes the walk O(window length)
/// whatever the interleaving, and across windows O(document length), because each of the four
/// cursors traverses each window exactly once. What it is *not* is a fresh search per tag:
/// dropping the cursor cache would make the `<triangle` search re-cross the entire run of
/// vertices for every vertex, which is the quadratic that `bytes_walked` exists to catch.
/// Comments cannot defeat the bound either: finding one only ever pushes the *other* cursors
/// forward past its end, and comments cannot nest or contain `--`, so searching for `-->` always
/// finds the true close.
///
/// Nothing in the last [`MARKER_LOOKAHEAD`] bytes is acted on unless `last`, because a marker
/// there may be cut in half by the window edge, and a marker *not* found is only proven absent up
/// to that same line. Both directions of that are what makes the answer independent of where the
/// chunk boundaries fall.
fn scan_window(
    bytes: &[u8],
    last: bool,
    visitor: &mut dyn ModelVisitor,
    walked: &mut u64,
) -> Result<WindowScan> {
    let limit = if last {
        bytes.len()
    } else {
        bytes.len().saturating_sub(MARKER_LOOKAHEAD)
    };
    if limit == 0 {
        return Ok(WindowScan {
            consumed_to: 0,
            entered_comment: false,
        });
    }

    let mut mesh_at = index_of_bytes(bytes, &MESH_TAG, 0, walked);
    let mut vertex_at = index_of_tag(bytes, &VERTEX_MARKER, 0, walked);
    let mut triangle_at = index_of_tag(bytes, &TRIANGLE_MARKER, 0, walked);
    let mut comment_at = index_of_bytes(bytes, &COMMENT_START, 0, walked);
    // How far this window has definitively consumed. Only `limit` can fall behind it: a comment
    // may close past the point where a marker stops being trustworthy, and dropping less than this
    // would hand the *next* window bytes that have already been interpreted. That is not merely
    // wasteful: the tail of a skipped comment re-entering the scan as document text is a
    // commented-out `<mesh` becoming a real object boundary, which silently rebases every later
    // triangle index.
    let mut processed_to = 0;

    loop {
        let next = [mesh_at, vertex_at, triangle_at, comment_at]
            .into_iter()
            .flatten()
            .min();
        // Nothing left in this window, or nothing left far enough from its edge to be read
        // safely. Either way the bytes from here on are the next window's problem.
        let Some(next) = next else {
            return Ok(WindowScan {
                consumed_to: limit.max(processed_to),
                entered_comment: false,
            });
        };
        if next >= limit {
            return Ok(WindowScan {
                consumed_to: next,
                entered_comment: false,
            });
        }

        if Some(next) == comment_at {
            let from = next + COMMENT_START.bytes.len();
            let Some(comment_end) = index_of_bytes(bytes, &COMMENT_END, from, walked) else {
                if last {
                    return Err(invalid("unterminated XML comment in 3MF model"));
                }
                return Ok(WindowScan {
                    consumed_to: next,
                    entered_comment: true,
                });
            };
            let past = comment_end + COMMENT_END.bytes.len();
            // Any marker already cached inside [comment_at, past) was found by a plain search
            // that doesn't know about comments; re-search it from past the comment's close.
            if mesh_at.is_some_and(|at| at < past) {
                mesh_at = index_of_bytes(bytes, &MESH_TAG, past, walked);
            }
            if vertex_at.is_some_and(|at| at < past) {
                vertex_at = index_of_tag(bytes, &VERTEX_MARKER, past, walked);
            }
            if triangle_at.is_some_and(|at| at < past) {
                triangle_at = index_of_tag(bytes, &TRIANGLE_MARKER, past, walked);
            }
            comment_at = index_of_bytes(bytes, &COMMENT_START, past, walked);
            processed_to = past;
            continue;
        }

        if Some(next) == mesh_at {
            visitor.mesh();
            processed_to = next + MESH_TAG.bytes.len();
            mesh_at = index_of_bytes(bytes, &MESH_TAG, processed_to, walked);
            continue;
        }

        if Some(next) == vertex_at {
            let Some(tag_end) = tag_end(bytes, next, walked) else {
                if last {
                    return Err(invalid("unterminated <vertex> tag in 3MF model"));
                }
                return Ok(WindowScan {
                    consumed_to: next,
                    entered_comment: false,
                });
            };
            visitor.vertex(&bytes[next..tag_end + 1])?;
            processed_to = tag_end + 1;
            vertex_at = index_of_tag(bytes, &VERTEX_MARKER, tag_end + 1, walked);
            continue;
        }

        // next == triangle_at
        let Some(tag_end) = tag_end(bytes, next, walked) else {
            if last {
                return Err(invalid("unterminated <triangle> tag in 3MF model"));
            }
            return Ok(WindowScan {
                consumed_to: next,
                entered_comment: false,
            });
        };
        visitor.triangle(&bytes[next..tag_end + 1])?;
        processed_to = tag_end + 1;
        triangle_at = index_of_tag(bytes, &TRIANGLE_MARKER, tag_end + 1, walked);
    }
}

/// The index of the `>` that closes the tag starting at `start`.
fn tag_end(bytes: &[u8], start: usize, walked: &mut u64) -> Option<usize> {
    let tail = &bytes[start..];
    let found = memchr::memchr(GT, tail);
    *walked += found.unwrap_or(tail.len()) as u64;
    found.map(|at| start + at)
}

fn invalid(message: &str) -> AppError {
    AppError::validation(message)
}

fn invalid_tag(message: &str, tag: &[u8]) -> AppError {
    let mut details = Map::new();
    details.insert(
        "tag".into(),
        Value::from(String::from_utf8_lossy(tag).into_owned()),
    );
    AppError::validation(message).with_details(details)
}

/// Feeds [`scan_window`] from a chunk stream, holding at most [`WINDOW_BYTES`] of the document.
///
/// The carry-over is a copy, and deliberately so: the zip reader hands out views into its own
/// buffer, and retaining one to join it to the next chunk would pin something unrelated to the
/// bytes actually wanted. Comments are the one construct that may legally run longer than the
/// window, and they are skipped *through* the stream rather than buffered: once the opening
/// `<!--` is seen without its close, the window is emptied down to the two bytes a straddling
/// `-->` could need and refilled until the close turns up. A 100 MB comment therefore costs 100 MB
/// of scanning and no memory at all.
struct ModelScanner<'a> {
    buffer: Box<[u8]>,
    len: usize,
    in_comment: bool,
    comment_from: usize,
    visitor: &'a mut dyn ModelVisitor,
    probe: &'a mut ScanProbe,
}

impl<'a> ModelScanner<'a> {
    fn new(visitor: &'a mut dyn ModelVisitor, probe: &'a mut ScanProbe) -> ModelScanner<'a> {
        ModelScanner {
            buffer: vec![0u8; WINDOW_BYTES].into_boxed_slice(),
            len: 0,
            in_comment: false,
            comment_from: 0,
            visitor,
            probe,
        }
    }

    fn drop_front(&mut self, count: usize) {
        if count == 0 {
            return;
        }
        self.buffer.copy_within(count..self.len, 0);
        self.len -= count;
    }

    fn drain(&mut self, last: bool) -> Result<()> {
        loop {
            if self.in_comment {
                let at = index_of_bytes(
                    &self.buffer[..self.len],
                    &COMMENT_END,
                    self.comment_from,
                    &mut self.probe.bytes_walked,
                );
                let Some(at) = at else {
                    if last {
                        return Err(invalid("unterminated XML comment in 3MF model"));
                    }
                    self.drop_front(self.len.saturating_sub(COMMENT_END.bytes.len() - 1));
                    self.comment_from = 0;
                    return Ok(());
                };
                self.drop_front(at + COMMENT_END.bytes.len());
                self.in_comment = false;
                self.comment_from = 0;
            }

            self.probe.peak_window_bytes = self.probe.peak_window_bytes.max(self.len);
            let scan = scan_window(
                &self.buffer[..self.len],
                last,
                &mut *self.visitor,
                &mut self.probe.bytes_walked,
            )?;
            self.drop_front(scan.consumed_to);
            if scan.entered_comment {
                self.in_comment = true;
                self.comment_from = COMMENT_START.bytes.len();
                continue;
            }
            // A full window that the scan could not advance through at all means one tag is wider
            // than the whole window. Refusing beats growing: the buffer would otherwise become a
            // function of the document, which is the property this parser exists to not have.
            if !last && self.len == self.buffer.len() {
                let mut details = Map::new();
                details.insert("windowBytes".into(), Value::from(WINDOW_BYTES as u64));
                return Err(AppError::validation(format!(
                    "3MF model has a tag longer than the parser's {WINDOW_BYTES}-byte window"
                ))
                .with_details(details));
            }
            return Ok(());
        }
    }
}

impl ChunkSink for ModelScanner<'_> {
    type Output = ();

    fn push(&mut self, chunk: &[u8]) -> Result<()> {
        let mut at = 0;
        while at < chunk.len() {
            let take = (chunk.len() - at).min(self.buffer.len() - self.len);
            self.buffer[self.len..self.len + take].copy_from_slice(&chunk[at..at + take]);
            self.len += take;
            at += take;
            if self.len == self.buffer.len() {
                self.drain(false)?;
            }
        }
        Ok(())
    }

    fn end(mut self) -> Result<()> {
        self.drain(true)
    }
}

/// XML whitespace as the attribute scan reads it: ASCII only. (The text this was ported from
/// matched `\s`, which also admits exotic Unicode spaces between attributes; no producer writes
/// them.)
const fn is_attr_space(byte: u8) -> bool {
    matches!(byte, 0x20 | 0x09 | 0x0a | 0x0b | 0x0c | 0x0d)
}

/// The first `(?:^|\s)<name>\s*=\s*(?:"([^"]*)"|'([^']*)')` in `tag`, as its value's bytes.
///
/// Anchored on "start-of-tag-or-whitespace" rather than a word boundary: a hyphen is a word
/// boundary but not whitespace, so a boundary would let a decoy like `p-x="77"` be mistaken for
/// the `x` attribute. Both quote styles and arbitrary whitespace around `=` are accepted, because
/// a pretty-printer is free to write `x = '0'`.
fn find_attribute<'t>(tag: &'t [u8], name: &[u8]) -> Option<&'t [u8]> {
    let skip_space = |mut at: usize| {
        while at < tag.len() && is_attr_space(tag[at]) {
            at += 1;
        }
        at
    };
    for (start, byte) in tag.iter().enumerate() {
        if !is_attr_space(*byte) || !tag[start + 1..].starts_with(name) {
            continue;
        }
        let at = skip_space(start + 1 + name.len());
        if tag.get(at) != Some(&b'=') {
            continue;
        }
        let at = skip_space(at + 1);
        let Some(&quote @ (b'"' | b'\'')) = tag.get(at) else {
            continue;
        };
        let value = &tag[at + 1..];
        if let Some(close) = memchr::memchr(quote, value) {
            return Some(&value[..close]);
        }
    }
    None
}

/// Reads one required, non-empty attribute out of an already-isolated tag. An empty or
/// whitespace-only value (`x=""`) would otherwise read as `0`, finite and a valid integer,
/// passing every downstream guard while silently placing a vertex or triangle index at 0 instead
/// of failing.
fn read_number(tag: &[u8], name: &str) -> Result<f64> {
    let value = find_attribute(tag, name.as_bytes())
        .map(String::from_utf8_lossy)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_tag(
                &format!("3MF tag is missing a valid \"{name}\" attribute"),
                tag,
            )
        })?;
    Ok(js_number(&value))
}

/// Pass one: only that a tag was seen, so nothing is decoded and nothing allocated per tag.
#[derive(Default)]
struct Counter {
    vertices: usize,
    triangles: usize,
}

impl ModelVisitor for Counter {
    fn mesh(&mut self) {}

    fn vertex(&mut self, _tag: &[u8]) -> Result<()> {
        self.vertices += 1;
        Ok(())
    }

    fn triangle(&mut self, _tag: &[u8]) -> Result<()> {
        self.triangles += 1;
        Ok(())
    }
}

/// Pass two: the same tags, resolved and written into the arrays pass one sized.
struct Filler {
    vertices: Vec<f32>,
    positions: Vec<f32>,
    expected_vertex_floats: usize,
    expected_position_floats: usize,
    /// Where the current `<mesh>`'s vertices start, in vertex (not float) units.
    vertex_base: usize,
}

impl Filler {
    fn changed() -> AppError {
        invalid("3MF model changed while it was being read")
    }
}

impl ModelVisitor for Filler {
    fn mesh(&mut self) {
        // A <triangle>'s v1/v2/v3 index into its *own* <mesh>'s <vertices> list, per the 3MF
        // spec, not a document-wide list: this is what keeps a second object's local index 0 from
        // silently resolving to the first object's first vertex.
        self.vertex_base = self.vertices.len() / 3;
    }

    fn vertex(&mut self, tag: &[u8]) -> Result<()> {
        let x = read_number(tag, "x")?;
        let y = read_number(tag, "y")?;
        let z = read_number(tag, "z")?;
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return Err(invalid_tag(
                "non-finite vertex coordinate in 3MF model",
                tag,
            ));
        }
        if self.vertices.len() + 3 > self.expected_vertex_floats {
            return Err(Filler::changed());
        }
        self.vertices.extend([x as f32, y as f32, z as f32]);
        Ok(())
    }

    fn triangle(&mut self, tag: &[u8]) -> Result<()> {
        let local_count = self.vertices.len() / 3 - self.vertex_base;
        if self.positions.len() + 9 > self.expected_position_floats {
            return Err(Filler::changed());
        }
        for name in ["v1", "v2", "v3"] {
            let index = read_number(tag, name)?;
            if !is_integer(index) || index < 0.0 || index >= local_count as f64 {
                return Err(invalid_tag(
                    "triangle vertex index out of range in 3MF model",
                    tag,
                ));
            }
            let vi = self.vertex_base + index as usize;
            self.positions
                .extend_from_slice(&self.vertices[vi * 3..vi * 3 + 3]);
        }
        Ok(())
    }
}

/// Parses the mesh geometry out of a 3MF file's `3D/3dmodel.model` entry, concatenating every
/// `<object>`'s mesh found in the document into one triangle soup. `<build>`/`<item>` transforms
/// are never read: the thumbnail only needs the shape, and the rasterizer fits its own bounding
/// box, so per-object placement on the build plate is irrelevant here.
///
/// Runs the same scan twice: once to count vertices and triangles so the vertex table and the
/// returned `positions` can be allocated exactly, then again to fill them.
///
/// **A second pass is a second stream, not a retained buffer**, and that is the trade this parser
/// makes: what it buys is hundreds of megabytes of document leaving the peak entirely; nothing in
/// between holds more than [`WINDOW_BYTES`].
pub fn parse_3mf_mesh(path: &Path, limits: &MeshLimits) -> Result<Mesh> {
    parse_3mf_mesh_probed(path, limits, &mut ScanProbe::default())
}

/// [`parse_3mf_mesh`] with the parse observable and interruptible. For tests.
#[doc(hidden)]
pub fn parse_3mf_mesh_probed(
    path: &Path,
    limits: &MeshLimits,
    probe: &mut ScanProbe,
) -> Result<Mesh> {
    // One descriptor for both passes. An unreadable or non-zip file fails here as a
    // `Validation` error, naming nothing but the archive.
    let zip = open_zip(path)?;
    let Some(model) = find_zip_entry(zip.entries(), MODEL_ENTRY_NAME) else {
        return Err(invalid(&format!(
            "3MF file has no {MODEL_ENTRY_NAME} entry"
        )));
    };
    let options = ZipChunkOptions {
        max_chunk_bytes: Some(ZIP_CHUNK_BYTES),
    };

    let mut counter = Counter::default();
    drain_sink(
        ModelScanner::new(&mut counter, probe),
        zip.read_chunks(model, options)?,
    )?;
    if counter.triangles == 0 {
        return Err(invalid("3MF model has no triangles"));
    }
    // Before the allocation, not after it: at this point the process holds one 256 KB window and
    // nothing else that scales with the file.
    assert_mesh_fits(counter.vertices as u64, counter.triangles as u64, limits)?;

    let expected_vertex_floats = counter.vertices * 3;
    let expected_position_floats = counter.triangles * 9;
    let mut filler = Filler {
        vertices: allocate_mesh(expected_vertex_floats, "vertex table")?,
        positions: allocate_mesh(expected_position_floats, "triangles")?,
        expected_vertex_floats,
        expected_position_floats,
        vertex_base: 0,
    };
    if let Some(before_fill) = probe.before_fill.as_mut() {
        before_fill();
    }
    drain_sink(
        ModelScanner::new(&mut filler, probe),
        zip.read_chunks(model, options)?,
    )?;

    // The two passes have to agree, and nothing else here would notice if they did not. A filling
    // pass that saw one tag more or fewer than the counting pass would otherwise return a mesh
    // with a silently dropped triangle: a plausible-looking picture, which is the one failure this
    // parser must not produce. Reachable when the file changes between the two streams.
    if filler.vertices.len() != expected_vertex_floats
        || filler.positions.len() != expected_position_floats
    {
        let mut details = Map::new();
        details.insert(
            "countedVertexFloats".into(),
            Value::from(expected_vertex_floats as u64),
        );
        details.insert(
            "wroteVertexFloats".into(),
            Value::from(filler.vertices.len() as u64),
        );
        details.insert(
            "countedPositionFloats".into(),
            Value::from(expected_position_floats as u64),
        );
        details.insert(
            "wrotePositionFloats".into(),
            Value::from(filler.positions.len() as u64),
        );
        return Err(Filler::changed().with_details(details));
    }

    Ok(Mesh {
        positions: filler.positions,
        triangle_count: counter.triangles,
    })
}
