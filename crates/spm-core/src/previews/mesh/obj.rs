//! Wavefront OBJ, from a buffer or streamed from disk.
//!
//! Only `v` and `f` are understood; everything else (`vn`, `vt`, `g`, `usemtl`, `o`, `s`,
//! `mtllib`, comments, blank lines) is skipped rather than failing the parse. A face with more
//! than three vertices is fan-triangulated around its first vertex.
//!
//! Two passes over the input, so the vertex table and `positions` are exactly the right size from
//! the start: a growing `Vec` would double its allocation and hold a second full-size copy beside
//! the first. Both entry points run the same visitors, over one buffer or over a chunk stream.

use std::path::Path;

use serde_json::{Map, Value};

use super::Mesh;
use super::jsnum::{is_integer, js_number};
use super::limits::{MeshLimits, allocate_mesh, assert_mesh_fits};
use crate::error::{AppError, Result};
use crate::files::chunks::{
    DEFAULT_FILE_CHUNK_BYTES, OpenFile, drain_sink, feed_sink, make_try_line_sink,
};

fn invalid(message: &str) -> AppError {
    AppError::validation(message)
}

fn invalid_with(message: &str, key: &str, value: &str) -> AppError {
    let mut details = Map::new();
    details.insert(key.to_owned(), Value::from(value));
    AppError::validation(message).with_details(details)
}

/// Resolves a face's vertex-index token (`5`, `-1`, `5/2`, `5/2/9`, `5//9`) to a 0-based offset
/// into the vertex list seen so far. Only the part before the first `/` is read: the texture and
/// normal indices that can follow are irrelevant to a shape-only preview.
///
/// Negative indices count back from the end of the vertex list *as of this face line*, per the
/// OBJ spec, which is why this takes `vertex_count` rather than a fixed total.
fn resolve_vertex_index(token: &str, vertex_count: usize) -> Result<usize> {
    let raw = token.split_once('/').map_or(token, |(head, _)| head);
    let index = js_number(raw);
    if !is_integer(index) || index == 0.0 {
        return Err(invalid_with(
            "malformed face vertex index in OBJ file",
            "token",
            token,
        ));
    }
    let resolved = if index > 0.0 {
        index - 1.0
    } else {
        vertex_count as f64 + index
    };
    if resolved < 0.0 || resolved >= vertex_count as f64 {
        return Err(invalid_with(
            "face vertex index is out of range in OBJ file",
            "token",
            token,
        ));
    }
    Ok(resolved as usize)
}

/// One logical line of an OBJ file, stripped of anything from the first `#` onward (a comment can
/// start anywhere on a line, not only at the start) and of surrounding whitespace, which also
/// removes the `\r` of a CRLF file, so line endings never reach the token split.
fn normalize_line(raw: &str) -> &str {
    let content = raw.split_once('#').map_or(raw, |(head, _)| head);
    content.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[derive(Debug, Clone, Copy, Default)]
struct ObjCounts {
    vertex_count: usize,
    triangle_count: usize,
}

/// Pass one: how many vertices, and how many triangles the faces will fan out to.
///
/// Validation here is limited to the "fewer than 3 vertices" shape check, since that is what the
/// triangle count depends on; coordinates and index ranges are pass two's business.
fn count_line(counts: &mut ObjCounts, raw: &str) -> Result<()> {
    let line = normalize_line(raw);
    if line.is_empty() {
        return Ok(());
    }
    let mut tokens = line.split_whitespace();
    match tokens.next() {
        Some("v") => counts.vertex_count += 1,
        Some("f") => {
            let face_vertex_count = tokens.count();
            if face_vertex_count < 3 {
                return Err(invalid_with(
                    "face with fewer than 3 vertices in OBJ file",
                    "line",
                    line,
                ));
            }
            // Fan-triangulating an n-gon yields n-2 triangles.
            counts.triangle_count += face_vertex_count - 2;
        }
        _ => {}
    }
    Ok(())
}

/// Pass two: the same lines, resolved and written into the arrays pass one sized.
struct Filler {
    vertices: Vec<f32>,
    positions: Vec<f32>,
    expected_vertex_floats: usize,
    expected_position_floats: usize,
}

impl Filler {
    fn new(counts: ObjCounts) -> Result<Filler> {
        let expected_vertex_floats = counts.vertex_count * 3;
        let expected_position_floats = counts.triangle_count * 9;
        Ok(Filler {
            vertices: allocate_mesh(expected_vertex_floats, "vertex table")?,
            positions: allocate_mesh(expected_position_floats, "triangles")?,
            expected_vertex_floats,
            expected_position_floats,
        })
    }

    fn changed() -> AppError {
        invalid("OBJ file changed while it was being read")
    }

    fn visit(&mut self, raw: &str) -> Result<()> {
        let line = normalize_line(raw);
        if line.is_empty() {
            return Ok(());
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        match tokens[0] {
            "v" => {
                let coordinate = |at: usize| tokens.get(at).map_or(f64::NAN, |t| js_number(t));
                let (x, y, z) = (coordinate(1), coordinate(2), coordinate(3));
                if !(x.is_finite() && y.is_finite() && z.is_finite()) {
                    return Err(invalid_with(
                        "non-finite vertex coordinate in OBJ file",
                        "line",
                        line,
                    ));
                }
                if self.vertices.len() + 3 > self.expected_vertex_floats {
                    return Err(Filler::changed());
                }
                self.vertices.extend([x as f32, y as f32, z as f32]);
            }
            "f" => {
                let vertex_count_so_far = self.vertices.len() / 3;
                let indices = tokens[1..]
                    .iter()
                    .map(|token| resolve_vertex_index(token, vertex_count_so_far))
                    .collect::<Result<Vec<usize>>>()?;
                // Fan-triangulate: every triangle shares idx[0], the rest walk the polygon's edge.
                for k in 1..indices.len().saturating_sub(1) {
                    if self.positions.len() + 9 > self.expected_position_floats {
                        return Err(Filler::changed());
                    }
                    for vi in [indices[0], indices[k], indices[k + 1]] {
                        self.positions
                            .extend_from_slice(&self.vertices[vi * 3..vi * 3 + 3]);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn into_mesh(self, counts: ObjCounts) -> Result<Mesh> {
        // Only reachable if the file changed between the two passes; without it a shortened file
        // would return an array whose tail was never written.
        if self.positions.len() != self.expected_position_floats {
            let mut details = Map::new();
            details.insert(
                "expectedFloats".into(),
                Value::from(self.expected_position_floats as u64),
            );
            details.insert(
                "wroteFloats".into(),
                Value::from(self.positions.len() as u64),
            );
            return Err(Filler::changed().with_details(details));
        }
        Ok(Mesh {
            positions: self.positions,
            triangle_count: counts.triangle_count,
        })
    }
}

/// Shared by both entry points: what pass one proved, checked before pass two allocates.
fn checked_counts(counts: ObjCounts, limits: &MeshLimits) -> Result<ObjCounts> {
    if counts.triangle_count == 0 {
        return Err(invalid("OBJ file has no faces"));
    }
    assert_mesh_fits(
        counts.vertex_count as u64,
        counts.triangle_count as u64,
        limits,
    )?;
    Ok(counts)
}

/// Parses Wavefront OBJ text out of a buffer the caller already holds.
pub fn parse_obj(bytes: &[u8], limits: &MeshLimits) -> Result<Mesh> {
    let mut counts = ObjCounts::default();
    feed_sink(
        make_try_line_sink(|line| count_line(&mut counts, line)),
        bytes,
    )?;
    let counts = checked_counts(counts, limits)?;
    let mut filler = Filler::new(counts)?;
    feed_sink(make_try_line_sink(|line| filler.visit(line)), bytes)?;
    filler.into_mesh(counts)
}

/// Parses an OBJ from disk without ever holding it whole.
///
/// Two reads rather than two walks over one decoded string: the live text is one incomplete line,
/// and reading the file twice costs almost nothing next to holding a 138 MB OBJ in memory beside
/// the mesh built from it.
pub fn parse_obj_file(path: &Path, limits: &MeshLimits) -> Result<Mesh> {
    // One descriptor for both passes.
    let file = OpenFile::open(path)?;
    let mut counts = ObjCounts::default();
    drain_sink(
        make_try_line_sink(|line| count_line(&mut counts, line)),
        file.chunks(DEFAULT_FILE_CHUNK_BYTES),
    )?;
    let counts = checked_counts(counts, limits)?;
    let mut filler = Filler::new(counts)?;
    drain_sink(
        make_try_line_sink(|line| filler.visit(line)),
        file.chunks(DEFAULT_FILE_CHUNK_BYTES),
    )?;
    filler.into_mesh(counts)
}
