//! Feeding a parser its input a piece at a time.
//!
//! A [`ChunkSink`] is a parser that is handed its input in pieces and produces its answer at the
//! end. The shape exists so that one parser body serves both a caller that already holds the
//! whole input ([`feed_sink`]) and one that must never hold it at all ([`drain_sink`]): there is
//! exactly one implementation of each format, not a buffered one and a streaming one that drift.
//!
//! A [`ChunkSource`] is the other end: a file ([`FileChunks`]) or one zip entry
//! (`zip::EntryChunks`), read in order in bounded pieces. Both reuse one buffer, so a chunk is
//! only valid until the next pull, and a sink may not retain a chunk past the `push` that
//! delivered it: copy what has to survive.

use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value};

use super::fsio::read_at;
use crate::error::{AppError, Result};

/// A parser that is handed its input a piece at a time and answers at the end.
pub trait ChunkSink {
    type Output;

    /// Takes the next piece. The slice is only valid for the duration of the call.
    fn push(&mut self, chunk: &[u8]) -> Result<()>;

    /// The input is over: produce the answer.
    fn end(self) -> Result<Self::Output>;
}

/// An ordered, bounded stream of byte chunks.
///
/// A lending iterator: the returned slice borrows the source's own buffer and is overwritten by
/// the next call, which is what keeps the memory bound independent of the input's size.
pub trait ChunkSource {
    /// The next chunk, or `None` at the end of the input.
    fn pull_chunk(&mut self) -> Result<Option<&[u8]>>;
}

/// Runs a sink over one buffer the caller already holds.
pub fn feed_sink<S: ChunkSink>(mut sink: S, bytes: &[u8]) -> Result<S::Output> {
    if !bytes.is_empty() {
        sink.push(bytes)?;
    }
    sink.end()
}

/// Runs a sink over a chunk source. A failing `push` or pull ends the run and drops the source,
/// which closes its file; nothing is left open.
pub fn drain_sink<S: ChunkSink, C: ChunkSource>(mut sink: S, mut source: C) -> Result<S::Output> {
    while let Some(chunk) = source.pull_chunk()? {
        if !chunk.is_empty() {
            sink.push(chunk)?;
        }
    }
    sink.end()
}

/// How much of a plain file is read at a time. Bigger than the 3MF parser's zip chunk because
/// nothing downstream of it copies per chunk.
pub const DEFAULT_FILE_CHUNK_BYTES: usize = 256 * 1024;

/// A file held open across several reads of it.
///
/// The parsers need a file more than once (STL sniffs its first 4 KB and then streams the body,
/// ASCII STL and OBJ stream it twice more to count and then to fill), and one `open` per read is
/// most of the cost on a library of small files. The descriptor closes when the `OpenFile` and
/// every [`FileChunks`] taken from it are dropped, so a stream can never read a descriptor that
/// has been recycled for another file.
#[derive(Debug, Clone)]
pub struct OpenFile {
    file: Arc<File>,
    size: u64,
}

impl OpenFile {
    pub fn open(path: &Path) -> Result<OpenFile> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(OpenFile {
            file: Arc::new(file),
            size,
        })
    }

    /// The first `max_bytes`, or the whole file if it is shorter.
    pub fn head(&self, max_bytes: usize) -> Result<Vec<u8>> {
        let mut buffer = vec![0u8; max_bytes.max(1)];
        let mut read = 0;
        while read < buffer.len() {
            match read_at(&self.file, &mut buffer[read..], read as u64) {
                Ok(0) => break,
                Ok(n) => read += n,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(error.into()),
            }
        }
        buffer.truncate(read);
        Ok(buffer)
    }

    /// The file from byte 0, in order. One pass; call again for another.
    pub fn chunks(&self, chunk_bytes: usize) -> FileChunks {
        // Never larger than the file as it was at `open`: a file that has grown since is not a
        // problem (it just arrives in more pieces) and a small one stops paying for a big buffer.
        let len = chunk_bytes
            .min(usize::try_from(self.size).unwrap_or(usize::MAX))
            .max(1);
        FileChunks {
            file: Arc::clone(&self.file),
            buffer: vec![0u8; len],
            position: 0,
        }
    }

    /// The length as of `open`, so the length a caller validates against and the length the
    /// reader allocates for cannot disagree, whatever the file does afterwards.
    pub fn size(&self) -> u64 {
        self.size
    }
}

/// One pass over a file in chunks of at most the requested size. See [`ChunkSource`].
#[derive(Debug)]
pub struct FileChunks {
    file: Arc<File>,
    buffer: Vec<u8>,
    position: u64,
}

impl ChunkSource for FileChunks {
    fn pull_chunk(&mut self) -> Result<Option<&[u8]>> {
        loop {
            match read_at(&self.file, &mut self.buffer, self.position) {
                Ok(0) => return Ok(None),
                Ok(n) => {
                    self.position += n as u64;
                    return Ok(Some(&self.buffer[..n]));
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
}

/// Reads a file as a stream of chunks, in order. The chunk is a view into one reused buffer and
/// is only valid until the next pull. For a caller that reads the same file more than once,
/// [`OpenFile`] is the same thing without the repeated `open`.
pub fn read_file_chunks(path: &Path, chunk_bytes: usize) -> Result<FileChunks> {
    Ok(OpenFile::open(path)?.chunks(chunk_bytes))
}

/// A line longer than this is refused rather than accumulated.
///
/// The carry-over a line sink holds is one incomplete line, so this constant *is* the sink's
/// memory bound: without it a file with no newline in it would be buffered whole. No text mesh
/// format writes a line remotely this long. It bounds the buffered callers too: one
/// line-splitting implementation is worth more than the buffered path's ability to accept a file
/// the streaming path could not.
pub const MAX_LINE_CHARS: usize = 1 << 20;

/// Splits a chunk stream into lines, keeping only the incomplete tail between pushes.
///
/// Lines arrive without their `\n`; a trailing `\r` is left on, because both callers already strip
/// whitespace and stripping it here would be a second place for the CRLF rule to live. The final
/// segment is always visited, even when it is empty: a file ending in `\n` ends with one empty
/// line.
///
/// Decoding is incremental: a multi-byte character split across a chunk boundary is held back and
/// completed rather than becoming two replacement characters.
pub fn make_line_sink<F: FnMut(&str)>(mut visit: F) -> LineSink<impl FnMut(&str) -> Result<()>> {
    make_try_line_sink(move |line| {
        visit(line);
        Ok(())
    })
}

/// [`make_line_sink`] for a visitor that can refuse a line: its first error ends the run.
///
/// The parsers need this: a malformed line is a `Validation` error, and a visitor that could only
/// stash the error and keep being called would read the rest of a file it has already rejected.
pub fn make_try_line_sink<F: FnMut(&str) -> Result<()>>(visit: F) -> LineSink<F> {
    LineSink {
        visit,
        pending: Vec::new(),
        carry: String::new(),
    }
}

/// The sink [`make_line_sink`] and [`make_try_line_sink`] build.
pub struct LineSink<F> {
    visit: F,
    /// The head of a multi-byte character the last chunk ended in the middle of (at most 3 bytes).
    pending: Vec<u8>,
    /// The incomplete last line. Never contains `\n`.
    carry: String,
}

impl<F> LineSink<F> {
    /// Decodes `pending + chunk`, appending to `text`; an incomplete trailing sequence stays in
    /// `pending`. `flush` turns it into one replacement character instead.
    fn decode(&mut self, chunk: &[u8], flush: bool, text: &mut String) {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    return;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(len) => {
                            text.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        None => {
                            if flush {
                                text.push('\u{FFFD}');
                            } else {
                                self.pending = after.to_vec();
                            }
                            return;
                        }
                    }
                }
            }
        }
    }
}

impl<F: FnMut(&str) -> Result<()>> ChunkSink for LineSink<F> {
    type Output = ();

    fn push(&mut self, chunk: &[u8]) -> Result<()> {
        let mut fresh = String::new();
        self.decode(chunk, false, &mut fresh);
        let mut rest = fresh.as_str();
        while let Some(at) = rest.find('\n') {
            let (line, tail) = rest.split_at(at);
            if self.carry.is_empty() {
                (self.visit)(line)?;
            } else {
                self.carry.push_str(line);
                let joined = (self.visit)(&self.carry);
                self.carry.clear();
                joined?;
            }
            rest = &tail[1..];
        }
        self.carry.push_str(rest);
        // The limit counts UTF-16 units, as the text it was measured on did; a UTF-8 length at or
        // under the limit cannot exceed it in UTF-16 units either, so the count is rarely taken.
        if self.carry.len() > MAX_LINE_CHARS && self.carry.encode_utf16().count() > MAX_LINE_CHARS {
            let mut details = Map::new();
            details.insert("maxLineChars".into(), Value::from(MAX_LINE_CHARS));
            return Err(AppError::validation(format!(
                "text line is longer than {MAX_LINE_CHARS} characters"
            ))
            .with_details(details));
        }
        Ok(())
    }

    fn end(mut self) -> Result<()> {
        let mut last = std::mem::take(&mut self.carry);
        self.decode(&[], true, &mut last);
        (self.visit)(&last)
    }
}
