//! STL, binary and ASCII, from a buffer or streamed from disk.
//!
//! One format implementation serves both: the sinks below are run over a chunk stream by
//! [`parse_stl_file`] and over one buffer by [`parse_stl`], so there is no second parser to
//! disagree with the first.

use std::path::Path;

use serde_json::{Map, Value};

use super::Mesh;
use super::jsnum::js_number;
use super::limits::{MeshLimits, allocate_mesh, assert_mesh_fits};
use crate::error::{AppError, Result};
use crate::files::chunks::{
    ChunkSink, DEFAULT_FILE_CHUNK_BYTES, OpenFile, drain_sink, feed_sink, make_try_line_sink,
};

/// An 80-byte free-form header and a `u32` triangle count.
const BINARY_HEADER_LENGTH: usize = 84;
/// Normal (12) + three vertices (36) + attribute byte count (2).
const BINARY_RECORD_LENGTH: usize = 50;

const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

/// How much of a file [`parse_stl_file`] reads before deciding how to read the rest.
///
/// Only the first 84 bytes decide anything (the header and the declared triangle count), but the
/// ASCII fallback skips a BOM and any leading whitespace before looking for the `solid` keyword,
/// and stopping at 84 would misjudge a file that opens with more than 76 bytes of blank lines.
/// 4 KB makes that impossible rather than merely unlikely, in one read of one page.
const SNIFF_BYTES: usize = 4096;

fn invalid(message: &str) -> AppError {
    AppError::validation(message)
}

fn invalid_with(message: &str, details: &[(&str, Value)]) -> AppError {
    let mut map = Map::new();
    for (key, value) in details {
        map.insert((*key).to_owned(), value.clone());
    }
    AppError::validation(message).with_details(map)
}

const fn is_ascii_whitespace(byte: u8) -> bool {
    matches!(byte, 0x20 | 0x09 | 0x0a | 0x0d | 0x0c)
}

/// True if, after skipping a leading UTF-8 BOM and any leading ASCII whitespace, the file spells
/// the ASCII STL keyword `solid` (case-insensitive).
///
/// Skipping the BOM and whitespace matters only for files at least [`BINARY_HEADER_LENGTH`] bytes
/// long: below that the ASCII path is taken unconditionally. At or above it, a strict "byte 0 is
/// `s`" check would misroute a genuine ASCII file into the "corrupt binary" branch.
fn looks_like_ascii_stl(bytes: &[u8]) -> bool {
    let mut start = if bytes.starts_with(&UTF8_BOM) { 3 } else { 0 };
    while start < bytes.len() && is_ascii_whitespace(bytes[start]) {
        start += 1;
    }
    bytes
        .get(start..start + 5)
        .is_some_and(|word| word.eq_ignore_ascii_case(b"solid"))
}

enum StlShape {
    Binary { triangle_count: u32 },
    Ascii,
}

/// Decides which of the two encodings a file is, from its first bytes and its total length.
///
/// Binary detection checks that the length matches `84 + 50 * triangle_count` exactly rather than
/// sniffing for `solid`: binary STLs routinely start with that word inside their free-form header.
/// It is also the gate that makes a declared triangle count safe to allocate against: a header
/// claiming four billion triangles cannot match any real file's length.
fn detect_stl(head: &[u8], total_bytes: u64) -> Result<StlShape> {
    if total_bytes >= BINARY_HEADER_LENGTH as u64 {
        if head.len() < BINARY_HEADER_LENGTH {
            return Err(invalid("STL file ended inside its header"));
        }
        let triangle_count = u32::from_le_bytes([head[80], head[81], head[82], head[83]]);
        let expected =
            BINARY_HEADER_LENGTH as u64 + BINARY_RECORD_LENGTH as u64 * u64::from(triangle_count);
        if total_bytes == expected {
            return Ok(StlShape::Binary { triangle_count });
        }
        if !looks_like_ascii_stl(head) {
            // Long enough to carry a binary header whose triangle count disagrees with the
            // file's length, and no ASCII keyword to fall back on either.
            return Err(invalid(
                "not a valid binary STL (triangle count does not match file length) and no ASCII \"solid\" keyword found",
            ));
        }
    }
    Ok(StlShape::Ascii)
}

/// Reassembles the fixed-size records of a binary STL out of arbitrary chunks.
///
/// The only state that crosses a chunk boundary is at most 49 bytes of a half-seen record; a
/// record that arrives whole inside one chunk is read straight out of it with no copy.
struct BinaryStlSink {
    positions: Vec<f32>,
    expected_floats: usize,
    triangle_count: u32,
    pending: [u8; BINARY_RECORD_LENGTH],
    pending_length: usize,
    skip: usize,
}

impl BinaryStlSink {
    fn new(triangle_count: u32, limits: &MeshLimits) -> Result<BinaryStlSink> {
        if triangle_count == 0 {
            return Err(invalid("STL file has zero triangles"));
        }
        assert_mesh_fits(0, u64::from(triangle_count), limits)?;
        let expected_floats = triangle_count as usize * 9;
        Ok(BinaryStlSink {
            positions: allocate_mesh(expected_floats, "triangles")?,
            expected_floats,
            triangle_count,
            pending: [0; BINARY_RECORD_LENGTH],
            pending_length: 0,
            skip: BINARY_HEADER_LENGTH,
        })
    }

    fn emit(&mut self, record: &[u8]) -> Result<()> {
        if self.positions.len() == self.expected_floats {
            return Err(invalid(
                "binary STL holds more triangles than its header declares",
            ));
        }
        let triangle_index = self.positions.len() / 9;
        // record[0..12] is the facet normal, skipped: the rasterizer recomputes shading from
        // geometry.
        for i in 0..9 {
            let at = 12 + i * 4;
            let value =
                f32::from_le_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]]);
            // The ASCII path rejects NaN/Infinity coordinates; a binary file with the same
            // problem must fail the same way rather than hand a NaN bounding box to the
            // rasterizer.
            if !value.is_finite() {
                return Err(invalid_with(
                    "binary STL contains a non-finite vertex coordinate",
                    &[("triangleIndex", Value::from(triangle_index as u64))],
                ));
            }
            self.positions.push(value);
        }
        Ok(())
    }
}

impl ChunkSink for BinaryStlSink {
    type Output = Mesh;

    fn push(&mut self, chunk: &[u8]) -> Result<()> {
        let mut at = 0;
        if self.skip > 0 {
            let n = self.skip.min(chunk.len());
            self.skip -= n;
            at = n;
        }
        while at < chunk.len() {
            if self.pending_length == 0 && chunk.len() - at >= BINARY_RECORD_LENGTH {
                self.emit(&chunk[at..at + BINARY_RECORD_LENGTH])?;
                at += BINARY_RECORD_LENGTH;
                continue;
            }
            let n = (BINARY_RECORD_LENGTH - self.pending_length).min(chunk.len() - at);
            self.pending[self.pending_length..self.pending_length + n]
                .copy_from_slice(&chunk[at..at + n]);
            self.pending_length += n;
            at += n;
            if self.pending_length == BINARY_RECORD_LENGTH {
                let record = self.pending;
                self.emit(&record)?;
                self.pending_length = 0;
            }
        }
        Ok(())
    }

    fn end(self) -> Result<Mesh> {
        // Only reachable if the file shrank between the length check and the read; the buffered
        // caller cannot get here at all. Still an error rather than a short mesh.
        if self.skip > 0 || self.pending_length > 0 || self.positions.len() != self.expected_floats
        {
            return Err(invalid_with(
                "binary STL ended before its declared triangle count",
                &[
                    ("declaredTriangles", Value::from(self.triangle_count)),
                    (
                        "readTriangles",
                        Value::from((self.positions.len() / 9) as u64),
                    ),
                ],
            ));
        }
        Ok(Mesh {
            positions: self.positions,
            triangle_count: self.triangle_count as usize,
        })
    }
}

// The grammar the ASCII path reads is `vertex` followed by three whitespace-separated tokens, one
// logical line at a time: anchored on the literal keyword rather than splitting the file into
// tokens, so a large ASCII file does not need every `facet normal` / `outer loop` / `endloop`
// token held at once. The reader carries one incomplete line between chunks, so a record whose
// three numbers are not all on one line does not match, and a non-match is *silent*: both passes
// drop it identically. `count_vertex_starts` below is the answer to that.

const VERTEX: &str = "vertex";

/// The `vertex\s+(\S+)\s+(\S+)\s+(\S+)` matches in `line`, left to right and non-overlapping, as
/// the three token slices each.
fn vertex_records(line: &str) -> Vec<[&str; 3]> {
    let mut records = Vec::new();
    let mut from = 0;
    while let Some(found) = line[from..].find(VERTEX) {
        let start = from + found;
        let after = start + VERTEX.len();
        match read_record(&line[after..]) {
            Some((tokens, consumed)) => {
                records.push(tokens);
                from = after + consumed;
            }
            None => from = start + 1,
        }
    }
    records
}

/// `\s+(\S+)\s+(\S+)\s+(\S+)` at the start of `rest`: the tokens and how many bytes it spans.
fn read_record(rest: &str) -> Option<([&str; 3], usize)> {
    let mut tokens = [""; 3];
    let mut at = 0;
    for token in &mut tokens {
        let tail = &rest[at..];
        let after_space = tail.trim_start_matches(char::is_whitespace);
        if after_space.len() == tail.len() {
            return None; // `\s+` needs at least one whitespace character
        }
        let word = after_space
            .find(char::is_whitespace)
            .unwrap_or(after_space.len());
        if word == 0 {
            return None; // `\S+` needs at least one character
        }
        *token = &after_space[..word];
        at = rest.len() - after_space.len() + word;
    }
    Some((tokens, at))
}

/// Every place a vertex record could begin: the keyword followed by whitespace or the end of the
/// line (`/vertex(?:\s|$)/g`).
///
/// The count of these has to equal the count of [`vertex_records`] on the same line, and that
/// equality is the whole reason this exists: a record whose three numbers are not all on its line
/// matches nothing, silently, and the "multiple of 3 per facet" check still passes whenever the
/// number of dropped records is a multiple of three. The result would be a mesh quietly missing
/// whole facets. Counting the starts turns that into a refusal.
///
/// The whitespace-or-end requirement keeps it from firing on ordinary text: a `solid vertexcube`
/// header contains the word and is not a record.
fn count_vertex_starts(line: &str) -> usize {
    let mut count = 0;
    let mut from = 0;
    while let Some(found) = line[from..].find(VERTEX) {
        let start = from + found;
        let after = start + VERTEX.len();
        match line[after..].chars().next() {
            None => {
                count += 1;
                from = after;
            }
            Some(c) if c.is_whitespace() => {
                count += 1;
                from = after + c.len_utf8();
            }
            Some(_) => from = start + 1,
        }
    }
    count
}

/// Pass one: how many coordinate values the fill pass is going to produce, and a refusal if any
/// line holds a `vertex` keyword it cannot read three numbers out of.
///
/// The refusal belongs here, before anything is allocated, and because a caller that never
/// reaches pass two (the count is zero, or the cap refuses) must still not be told the file was
/// fine.
fn count_line(values: &mut usize, line: &str) -> Result<()> {
    let records = vertex_records(line).len();
    if records != count_vertex_starts(line) {
        return Err(invalid_with(
            "ASCII STL has a vertex record that is not three numbers on one line",
            &[("line", Value::from(line))],
        ));
    }
    *values += records * 3;
    Ok(())
}

/// Pass two: the same matches, validated and written into the array pass one sized.
fn fill_line(positions: &mut Vec<f32>, expected: usize, line: &str) -> Result<()> {
    for record in vertex_records(line) {
        let x = js_number(record[0]);
        let y = js_number(record[1]);
        let z = js_number(record[2]);
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return Err(invalid_with(
                "malformed vertex line in ASCII STL",
                &[(
                    "line",
                    Value::from(format!(
                        "{VERTEX} {} {} {}",
                        record[0], record[1], record[2]
                    )),
                )],
            ));
        }
        if positions.len() + 3 > expected {
            return Err(invalid("ASCII STL grew while it was being read"));
        }
        positions.extend([x as f32, y as f32, z as f32]);
    }
    Ok(())
}

/// What pass one proved, turned into the allocation pass two fills, or a refusal.
fn ascii_positions_for(values: usize, limits: &MeshLimits) -> Result<Vec<f32>> {
    if values == 0 {
        return Err(invalid("STL file has zero triangles"));
    }
    if !values.is_multiple_of(9) {
        return Err(invalid(
            "ASCII STL vertex count is not a multiple of 3 per facet",
        ));
    }
    assert_mesh_fits(0, (values / 9) as u64, limits)?;
    allocate_mesh(values, "triangles")
}

fn ascii_mesh(positions: Vec<f32>, expected: usize) -> Result<Mesh> {
    if positions.len() != expected {
        return Err(invalid("ASCII STL shrank while it was being read"));
    }
    Ok(Mesh {
        triangle_count: positions.len() / 9,
        positions,
    })
}

/// Parses either STL encoding out of a buffer the caller already holds.
///
/// The only place the format logic lives: [`parse_stl_file`] runs the identical sinks over a
/// chunk stream instead of over one slice.
pub fn parse_stl(bytes: &[u8], limits: &MeshLimits) -> Result<Mesh> {
    match detect_stl(bytes, bytes.len() as u64)? {
        StlShape::Binary { triangle_count } => {
            feed_sink(BinaryStlSink::new(triangle_count, limits)?, bytes)
        }
        StlShape::Ascii => {
            let mut values = 0;
            feed_sink(
                make_try_line_sink(|line| count_line(&mut values, line)),
                bytes,
            )?;
            let mut positions = ascii_positions_for(values, limits)?;
            feed_sink(
                make_try_line_sink(|line| fill_line(&mut positions, values, line)),
                bytes,
            )?;
            ascii_mesh(positions, values)
        }
    }
}

/// Parses an STL from disk without ever holding it whole.
///
/// The reference library's largest model is a 164 MB binary STL; reading it whole charged all
/// 164 MB against the peak on top of the 118.7 MB of `positions` it actually needed. Here the file
/// passes through a 256 KB buffer, and streaming is faster than reading it whole besides.
///
/// ASCII costs two reads because the vertex count is not knowable without one: the alternative is
/// a growing `Vec` that doubles its allocation, which is a second full-size copy alive beside the
/// first. Binary needs one read, its count being in the header.
pub fn parse_stl_file(path: &Path, limits: &MeshLimits) -> Result<Mesh> {
    // One descriptor for the sniff, the size and both passes: on the library's 1 300 small models
    // the parse is a fraction of a millisecond and the syscalls are not.
    let file = OpenFile::open(path)?;
    match detect_stl(&file.head(SNIFF_BYTES)?, file.size())? {
        StlShape::Binary { triangle_count } => drain_sink(
            BinaryStlSink::new(triangle_count, limits)?,
            file.chunks(DEFAULT_FILE_CHUNK_BYTES),
        ),
        StlShape::Ascii => {
            let mut values = 0;
            drain_sink(
                make_try_line_sink(|line| count_line(&mut values, line)),
                file.chunks(DEFAULT_FILE_CHUNK_BYTES),
            )?;
            let mut positions = ascii_positions_for(values, limits)?;
            drain_sink(
                make_try_line_sink(|line| fill_line(&mut positions, values, line)),
                file.chunks(DEFAULT_FILE_CHUNK_BYTES),
            )?;
            ascii_mesh(positions, values)
        }
    }
}
