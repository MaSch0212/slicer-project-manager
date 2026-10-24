//! A streaming zip reader.
//!
//! Reads the central directory (zip64 included) and one entry at a time, either buffered
//! ([`OpenZip::read`], for the small config parts a classifier or thumbnail lookup needs) or as a
//! bounded stream of chunks ([`OpenZip::read_chunks`], for a 3MF model part that inflates to
//! hundreds of megabytes). Nothing here trusts the archive: every length, offset and count comes
//! out of the file itself, so each is proven in range before it reaches an allocation or a read,
//! and a lie is a `Validation` error rather than a panic or an out-of-memory abort.
//!
//! # Memory bounds
//!
//! * The central directory is read whole, but its size is checked against the file's first.
//! * A buffered read holds one entry, and never more than the entry *declares*: inflation stops
//!   one byte past the declared size, so an archive that declares 3 bytes and inflates to 300 MB
//!   is refused having produced 4 (the central directory's size is what an importer charges a
//!   quota against, so what comes out has to be what was declared).
//! * A chunked read holds one chunk buffer of at most the requested size plus the inflater's
//!   window and a 32 KiB slice of compressed input, whatever the entry's compression ratio. Output
//!   is checked against the declared size as it is produced, so a bomb is refused mid-stream.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;
use std::sync::{Arc, Mutex};

use flate2::read::DeflateDecoder;
use serde_json::{Map, Value};

use super::chunks::ChunkSource;
use super::fsio::{read_at, read_exact_at};
use crate::error::{AppError, Result};

/// One central-directory record.
///
/// The first five fields are everything a *reader* needs. The rest are carried for the rewriter
/// (`zip_write`), which has to reproduce a record it did not author: the general-purpose flags
/// decide whether an entry is encrypted (bit 0) or defers its sizes to a data descriptor (bit 3),
/// and the CRC, DOS timestamp and attribute words are payload-independent facts about the entry
/// that a copy has no business inventing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
    /// General-purpose bit flag. Bit 0 is encryption, bit 3 a data descriptor, bit 11 UTF-8 names.
    pub flags: u16,
    /// CRC-32 of the *uncompressed* data, as the central directory declares it.
    pub crc: u32,
    /// MS-DOS modification time and date, verbatim. Not decoded; nothing here needs a date.
    pub mod_time: u16,
    pub mod_date: u16,
    /// High byte is the host system, low byte the ZIP spec version the writer claimed.
    pub version_made_by: u16,
    pub version_needed: u16,
    pub internal_attributes: u16,
    pub external_attributes: u32,
}

const EOCD_SIG: u32 = 0x0605_4b50;
const CD_SIG: u32 = 0x0201_4b50;
const LOCAL_SIG: u32 = 0x0403_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const EOCD_MIN: usize = 22;
const CD_MIN: usize = 46;
const ZIP64_LOCATOR_SIZE: usize = 20;
const ZIP64_EOCD_MIN: usize = 56;
/// Header id of the zip64 extended information extra field (APPNOTE 4.5.3).
const ZIP64_EXTRA_ID: u16 = 0x0001;
const MAX_COMMENT: usize = 0xffff;
/// The "look in the zip64 record instead" sentinel, for 32-bit and 16-bit fields respectively.
const U32_MAX: u64 = 0xffff_ffff;
const U16_MAX: u64 = 0xffff;
/// The largest integer a JavaScript number holds exactly. Zip64 counts sizes and offsets as
/// unsigned 64-bit; the legacy reader refused anything past this rather than rounding it into a
/// plausible wrong offset, and so does this one, which keeps every offset far inside `i64`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Upper bound on a chunk handed to a [`EntryChunks`] consumer, unless it asks for less.
pub const DEFAULT_ZIP_CHUNK_BYTES: usize = 1 << 20;

/// How much compressed data is read from disk at a time while inflating.
const COMPRESSED_SLICE_BYTES: usize = 32 * 1024;

/// Ceiling on the up-front size hint for a buffered inflate; see [`inflate_entry`].
const MAX_INFLATE_PREALLOCATION: u64 = 1 << 30;

/// DEFLATE cannot expand data by more than about 1032:1, so an entry's output cannot exceed this
/// multiple of its compressed size (plus a small constant for tiny streams).
const MAX_DEFLATE_RATIO: u64 = 1032;

fn zip_error(message: impl Into<String>) -> AppError {
    AppError::validation(message)
}

fn zip_error_with(message: impl Into<String>, key: &str, value: Value) -> AppError {
    let mut details = Map::new();
    details.insert(key.to_owned(), value);
    AppError::validation(message).with_details(details)
}

/// What a `TextDecoder` does with bytes: lossy UTF-8, and a leading byte-order mark is dropped.
pub fn decode_utf8(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    match text.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_owned(),
        None => text.into_owned(),
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}

/// An archive file with its length as of `open`.
#[derive(Debug, Clone)]
struct Source {
    file: Arc<File>,
    size: u64,
}

impl Source {
    fn open(path: &Path) -> Result<Source> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Source {
            file: Arc::new(file),
            size,
        })
    }

    /// `length` bytes at `position`, with both proven against the file before anything is
    /// allocated: a central directory can lie, and `vec![0; 2^52]` answers a lie with an abort.
    fn read_at(&self, position: u64, length: u64) -> Result<Vec<u8>> {
        // A position past the safe-integer range is a lying directory, not a place in a file.
        if position > MAX_SAFE_INTEGER {
            return Err(zip_error_with(
                "zip declares an impossible offset",
                "position",
                Value::from(position),
            ));
        }
        let end = position.checked_add(length);
        if end.is_none_or(|end| end > self.size) {
            return Err(zip_error("unexpected end of zip file"));
        }
        let length = usize::try_from(length).map_err(|_| {
            zip_error_with(
                "zip declares an impossible length",
                "length",
                Value::from(length),
            )
        })?;
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(length).map_err(|_| {
            zip_error_with(
                "zip declares an impossible length",
                "length",
                Value::from(length),
            )
        })?;
        buffer.resize(length, 0);
        read_exact_at(&self.file, &mut buffer, position).map_err(source_error)?;
        Ok(buffer)
    }
}

/// A read that fell short is the archive's doing; anything else is the file system's.
fn source_error(error: io::Error) -> AppError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        zip_error("unexpected end of zip file")
    } else {
        AppError::from(error)
    }
}

/// Zip64 counts sizes and offsets as unsigned 64-bit. An out-of-range value is rejected here
/// rather than silently rounded into a plausible-looking wrong offset.
fn to_safe(value: u64, what: &str) -> Result<u64> {
    if value > MAX_SAFE_INTEGER {
        return Err(zip_error_with(
            format!("zip64 {what} is too large to read"),
            "value",
            Value::from(value.to_string()),
        ));
    }
    Ok(value)
}

struct Zip64End {
    total: u64,
    cd_size: u64,
    cd_offset: u64,
}

/// Reads the zip64 end-of-central-directory locator and the record it points at.
///
/// Called only when the ordinary end-of-central-directory record has saturated a field, so an
/// archive that never needed zip64 never comes through here. The locator sits immediately in front
/// of the EOCD it belongs to, which is what makes it findable without scanning.
fn read_zip64_end(source: &Source, eocd_at: u64) -> Result<Zip64End> {
    let missing = || zip_error("zip64 end-of-central-directory locator is missing");
    let locator_at = eocd_at
        .checked_sub(ZIP64_LOCATOR_SIZE as u64)
        .ok_or_else(missing)?;
    let locator = source.read_at(locator_at, ZIP64_LOCATOR_SIZE as u64)?;
    if u32_at(&locator, 0) != ZIP64_LOCATOR_SIG {
        return Err(missing());
    }
    let record_at = to_safe(
        u64_at(&locator, 8),
        "end-of-central-directory record offset",
    )?;
    if record_at + ZIP64_EOCD_MIN as u64 > source.size {
        return Err(zip_error("truncated zip64 end-of-central-directory record"));
    }
    let record = source.read_at(record_at, ZIP64_EOCD_MIN as u64)?;
    if u32_at(&record, 0) != ZIP64_EOCD_SIG {
        return Err(zip_error("corrupt zip64 end-of-central-directory record"));
    }
    Ok(Zip64End {
        total: to_safe(u64_at(&record, 32), "entry count")?,
        cd_size: to_safe(u64_at(&record, 40), "central directory size")?,
        cd_offset: to_safe(u64_at(&record, 48), "central directory offset")?,
    })
}

#[derive(Clone, Copy)]
struct Zip64Sizes {
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
}

/// Applies the zip64 extended information extra field of one central-directory entry.
///
/// The field is positional, not tagged: it holds only those values whose base field is
/// `0xffffffff`, in the fixed order uncompressed size, compressed size, local header offset, disk
/// number — so which 64-bit word means what depends entirely on the base record. The base value is
/// both the gate and the default: a field that is not saturated is never taken from here.
fn apply_zip64_extra(
    cd: &[u8],
    extra_start: usize,
    extra_end: usize,
    base: Zip64Sizes,
) -> Result<Zip64Sizes> {
    let mut at = extra_start;
    while at + 4 <= extra_end {
        let id = u16_at(cd, at);
        let size = usize::from(u16_at(cd, at + 2));
        let body = at + 4;
        if body + size > extra_end {
            return Err(zip_error("corrupt zip extra field"));
        }
        if id != ZIP64_EXTRA_ID {
            at = body + size;
            continue;
        }

        let mut p = body;
        let mut take = |what: &str| -> Result<u64> {
            if p + 8 > body + size {
                return Err(zip_error(format!(
                    "zip64 extra field is missing the {what}"
                )));
            }
            let value = to_safe(u64_at(cd, p), what)?;
            p += 8;
            Ok(value)
        };
        // Sequential, not a struct literal: the order these three run in is the wire format.
        let uncompressed_size = if base.uncompressed_size == U32_MAX {
            take("uncompressed size")?
        } else {
            base.uncompressed_size
        };
        let compressed_size = if base.compressed_size == U32_MAX {
            take("compressed size")?
        } else {
            base.compressed_size
        };
        let local_header_offset = if base.local_header_offset == U32_MAX {
            take("local header offset")?
        } else {
            base.local_header_offset
        };
        return Ok(Zip64Sizes {
            compressed_size,
            uncompressed_size,
            local_header_offset,
        });
    }
    Err(zip_error(
        "zip entry needs a zip64 extra field but has none",
    ))
}

fn read_entries(source: &Source) -> Result<Vec<ZipEntry>> {
    let size = source.size;
    if size < EOCD_MIN as u64 {
        return Err(zip_error("file is too small to be a zip"));
    }

    let tail_length = size.min((EOCD_MIN + MAX_COMMENT) as u64);
    let tail_start = size - tail_length;
    let tail = source.read_at(tail_start, tail_length)?;

    let eocd = (0..=tail.len() - EOCD_MIN)
        .rev()
        .find(|&i| u32_at(&tail, i) == EOCD_SIG)
        .ok_or_else(|| zip_error("no zip end-of-central-directory record"))?;

    let mut total = u64::from(u16_at(&tail, eocd + 10));
    let mut cd_size = u64::from(u32_at(&tail, eocd + 12));
    let mut cd_offset = u64::from(u32_at(&tail, eocd + 16));
    // A zip64 value is authoritative only where the base field is saturated. Each of the three is
    // gated on its own sentinel because a writer saturates only what it feels like saturating,
    // not only what does not fit.
    if total == U16_MAX || cd_size == U32_MAX || cd_offset == U32_MAX {
        let end = read_zip64_end(source, tail_start + eocd as u64)?;
        if total == U16_MAX {
            total = end.total;
        }
        if cd_size == U32_MAX {
            cd_size = end.cd_size;
        }
        if cd_offset == U32_MAX {
            cd_offset = end.cd_offset;
        }
    }
    if cd_offset + cd_size > size {
        return Err(zip_error("zip central directory lies outside the file"));
    }

    let cd = source.read_at(cd_offset, cd_size)?;
    let mut entries = Vec::new();
    let mut p = 0usize;

    for _ in 0..total {
        // The entry count can itself come from a zip64 record, so it is not trusted to agree with
        // the bytes actually present; every field read below is proven in range first.
        if p + CD_MIN > cd.len() || u32_at(&cd, p) != CD_SIG {
            return Err(zip_error("corrupt zip central directory"));
        }
        let name_length = usize::from(u16_at(&cd, p + 28));
        let extra_length = usize::from(u16_at(&cd, p + 30));
        let next = p + CD_MIN + name_length + extra_length + usize::from(u16_at(&cd, p + 32));
        if next > cd.len() {
            return Err(zip_error("corrupt zip central directory"));
        }

        let base = Zip64Sizes {
            compressed_size: u64::from(u32_at(&cd, p + 20)),
            uncompressed_size: u64::from(u32_at(&cd, p + 24)),
            local_header_offset: u64::from(u32_at(&cd, p + 42)),
        };
        let sizes = if base.compressed_size == U32_MAX
            || base.uncompressed_size == U32_MAX
            || base.local_header_offset == U32_MAX
        {
            apply_zip64_extra(
                &cd,
                p + CD_MIN + name_length,
                p + CD_MIN + name_length + extra_length,
                base,
            )?
        } else {
            base
        };

        entries.push(ZipEntry {
            method: u16_at(&cd, p + 10),
            compressed_size: sizes.compressed_size,
            uncompressed_size: sizes.uncompressed_size,
            local_header_offset: sizes.local_header_offset,
            name: decode_utf8(&cd[p + CD_MIN..p + CD_MIN + name_length]),
            version_made_by: u16_at(&cd, p + 4),
            version_needed: u16_at(&cd, p + 6),
            flags: u16_at(&cd, p + 8),
            mod_time: u16_at(&cd, p + 12),
            mod_date: u16_at(&cd, p + 14),
            crc: u32_at(&cd, p + 16),
            internal_attributes: u16_at(&cd, p + 36),
            external_attributes: u32_at(&cd, p + 38),
        });
        p = next;
    }
    Ok(entries)
}

/// The entries of the archive at `path`, in central-directory order.
///
/// Every way the *contents* are rejected (too small, no end record, a corrupt directory) is a
/// `Validation` error; anything else is the file system refusing the open or the read, and says
/// nothing about the contents (`classify` depends on that distinction).
pub fn read_zip_entries(path: &Path) -> Result<Vec<ZipEntry>> {
    read_entries(&Source::open(path)?)
}

pub fn find_zip_entry<'a>(entries: &'a [ZipEntry], name: &str) -> Option<&'a ZipEntry> {
    entries.iter().find(|entry| entry.name == name)
}

/// One entry, inflated into a single buffer. For the small parts; a large one wants
/// [`OpenZip::read_chunks`].
pub fn read_zip_entry_bytes(path: &Path, entry: &ZipEntry) -> Result<Vec<u8>> {
    read_entry_from(&Source::open(path)?, entry)
}

/// One entry as text, decoded the way a `TextDecoder` does.
pub fn read_zip_entry_text(path: &Path, entry: &ZipEntry) -> Result<String> {
    Ok(decode_utf8(&read_zip_entry_bytes(path, entry)?))
}

/// Options for a chunked read.
#[derive(Debug, Clone, Copy, Default)]
pub struct ZipChunkOptions {
    /// Upper bound on each yielded chunk. Defaults to [`DEFAULT_ZIP_CHUNK_BYTES`]. A cap on the
    /// *chunk*: the reader's own memory is already bounded, and lowering this only makes the same
    /// bytes arrive in more pieces.
    pub max_chunk_bytes: Option<usize>,
}

/// A zip held open across many reads, on one descriptor.
///
/// The descriptor closes when the `OpenZip` and every [`EntryChunks`] taken from it are dropped.
/// A stream therefore cannot outlive its file and cannot read a recycled descriptor.
#[derive(Debug, Clone)]
pub struct OpenZip {
    entries: Vec<ZipEntry>,
    source: Source,
}

/// Opens the archive at `path` and reads its directory.
pub fn open_zip(path: &Path) -> Result<OpenZip> {
    let source = Source::open(path)?;
    let entries = read_entries(&source)?;
    Ok(OpenZip { entries, source })
}

impl OpenZip {
    pub fn entries(&self) -> &[ZipEntry] {
        &self.entries
    }

    /// One entry, buffered.
    pub fn read(&self, entry: &ZipEntry) -> Result<Vec<u8>> {
        read_entry_from(&self.source, entry)
    }

    /// Streams an entry in chunks of at most `options.max_chunk_bytes`, in order.
    ///
    /// The point is that a 674 MB model part no longer *has* to be one allocation: a consumer that
    /// only needs a sliding window over the bytes can pull chunks and keep a small carry-over.
    pub fn read_chunks(&self, entry: &ZipEntry, options: ZipChunkOptions) -> Result<EntryChunks> {
        chunks_from(&self.source, entry, options)
    }
}

/// Whether this file's central directory parses.
///
/// It exists to tell "mid-write" from "not a ZIP": a hash of a `.3mf` a slicer is halfway through
/// writing is a perfectly plausible hash of half a file. It answers about the **directory**, not
/// the payload, and a file that cannot be opened at all is `false` too: every reason this can be
/// false is a reason to wait.
pub fn reads_as_zip(path: &Path) -> bool {
    open_zip(path).is_ok()
}

/// Reads one entry as a stream of chunks, opening the file for the life of the stream.
pub fn read_zip_entry_chunks(
    path: &Path,
    entry: &ZipEntry,
    options: ZipChunkOptions,
) -> Result<EntryChunks> {
    chunks_from(&Source::open(path)?, entry, options)
}

/// The body of `read_zip_entry_bytes`, against an already-open file.
fn read_entry_from(source: &Source, entry: &ZipEntry) -> Result<Vec<u8>> {
    let data_offset = data_offset_of(source, entry)?;
    match entry.method {
        0 => {
            let data = source.read_at(data_offset, entry.compressed_size)?;
            assert_declared_size(data.len() as u64, entry.uncompressed_size)?;
            Ok(data)
        }
        8 => inflate_entry(source, data_offset, entry),
        method => Err(unsupported_method(method)),
    }
}

fn unsupported_method(method: u16) -> AppError {
    zip_error(format!("unsupported zip compression method {method}"))
}

/// Where an entry's data starts: past its local header, whose name and extra field lengths are its
/// own and routinely differ from the central directory's copy. The compressed bytes the directory
/// declares must lie inside the file, so an impossible size is refused before anything is read or
/// allocated for it.
fn data_offset_of(source: &Source, entry: &ZipEntry) -> Result<u64> {
    let header = source.read_at(entry.local_header_offset, 30)?;
    if u32_at(&header, 0) != LOCAL_SIG {
        return Err(zip_error("corrupt zip local header"));
    }
    let data_offset = entry.local_header_offset
        + 30
        + u64::from(u16_at(&header, 26))
        + u64::from(u16_at(&header, 28));
    if data_offset
        .checked_add(entry.compressed_size)
        .is_none_or(|end| end > source.size)
    {
        return Err(zip_error("unexpected end of zip file"));
    }
    Ok(data_offset)
}

/// Shared by the stored and deflated paths, hence "yields" rather than "inflates to".
fn assert_declared_size(actual: u64, declared: u64) -> Result<()> {
    if actual != declared {
        let mut details = Map::new();
        details.insert("declared".into(), Value::from(declared));
        details.insert("actual".into(), Value::from(actual));
        return Err(
            zip_error("zip entry does not yield its declared uncompressed size")
                .with_details(details),
        );
    }
    Ok(())
}

/// Inflates one entry into a single buffer.
///
/// Output is capped one byte past the declared size, so an entry that lies about its size costs at
/// most that much before it is refused. The up-front allocation hint is the declared size, capped
/// by the most DEFLATE can expand the compressed bytes (so a lying directory cannot demand a huge
/// allocation for a tiny entry) and by [`MAX_INFLATE_PREALLOCATION`]; an entry genuinely larger
/// than that simply grows its buffer.
fn inflate_entry(source: &Source, data_offset: u64, entry: &ZipEntry) -> Result<Vec<u8>> {
    let failure = SourceFailure::default();
    let reader = RangeReader::new(source, data_offset, entry.compressed_size, &failure);
    let decoder = DeflateDecoder::new(BufReader::with_capacity(COMPRESSED_SLICE_BYTES, reader));
    let declared = entry.uncompressed_size;

    let hint = declared
        .min(
            entry
                .compressed_size
                .saturating_mul(MAX_DEFLATE_RATIO)
                .saturating_add(64),
        )
        .min(MAX_INFLATE_PREALLOCATION);
    let mut inflated = Vec::new();
    inflated
        .try_reserve_exact(usize::try_from(hint).unwrap_or(0))
        .ok();

    let mut limited = decoder.take(declared.saturating_add(1));
    limited
        .read_to_end(&mut inflated)
        .map_err(|error| failure.explain(&error))?;
    assert_declared_size(inflated.len() as u64, declared)?;
    Ok(inflated)
}

/// Whether the compressed side (the archive file) failed, as distinct from the inflater: only a
/// failure to *read* the archive is a source failure, and the inflater's own error is not.
#[derive(Debug, Clone, Default)]
struct SourceFailure(Arc<Mutex<Option<io::ErrorKind>>>);

impl SourceFailure {
    fn record(&self, kind: io::ErrorKind) {
        if let Ok(mut slot) = self.0.lock() {
            slot.get_or_insert(kind);
        }
    }

    /// The error an inflate failure should surface as.
    fn explain(&self, error: &io::Error) -> AppError {
        let recorded = self.0.lock().ok().and_then(|slot| *slot);
        match recorded {
            Some(io::ErrorKind::UnexpectedEof) => zip_error("unexpected end of zip file"),
            Some(kind) => AppError::from(io::Error::from(kind)),
            None => zip_error_with(
                "zip entry could not be inflated",
                "cause",
                Value::from(error.to_string()),
            ),
        }
    }
}

/// The compressed bytes of one entry, read straight out of the archive file at explicit offsets.
struct RangeReader {
    file: Arc<File>,
    position: u64,
    end: u64,
    failure: SourceFailure,
}

impl RangeReader {
    fn new(source: &Source, start: u64, length: u64, failure: &SourceFailure) -> RangeReader {
        RangeReader {
            file: Arc::clone(&source.file),
            position: start,
            end: start.saturating_add(length),
            failure: failure.clone(),
        }
    }
}

impl Read for RangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.end {
            return Ok(0);
        }
        let want =
            usize::try_from((self.end - self.position).min(buf.len() as u64)).unwrap_or(buf.len());
        loop {
            match read_at(&self.file, &mut buf[..want], self.position) {
                // The archive ended before the bytes it declared: the directory lied.
                Ok(0) => {
                    self.failure.record(io::ErrorKind::UnexpectedEof);
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                Ok(n) => {
                    self.position += n as u64;
                    return Ok(n);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    self.failure.record(error.kind());
                    return Err(error);
                }
            }
        }
    }
}

/// An entry read in order, in chunks of at most the requested size. See [`ChunkSource`].
///
/// One buffer is allocated up front (never larger than the requested bound, nor than the entry
/// declares) and reused, so a consumer that wants a chunk past the next pull copies it; or uses
/// the [`Iterator`] impl, which hands out an owned copy each time. The inflater is bounded by the
/// chunk buffer, not by the entry's compression ratio: a 1000:1 entry costs no more than a 1:1 one.
///
/// Dropping the stream part-way closes the file (once nothing else holds it): there is nothing to
/// cancel.
#[derive(Debug)]
pub struct EntryChunks {
    buffer: Vec<u8>,
    declared: u64,
    produced: u64,
    finished: bool,
    reader: ChunkReader,
}

enum ChunkReader {
    Stored(RangeReader),
    Deflated {
        decoder: Box<DeflateDecoder<BufReader<RangeReader>>>,
        failure: SourceFailure,
    },
}

impl std::fmt::Debug for ChunkReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChunkReader::Stored(_) => f.write_str("Stored"),
            ChunkReader::Deflated { .. } => f.write_str("Deflated"),
        }
    }
}

fn chunks_from(source: &Source, entry: &ZipEntry, options: ZipChunkOptions) -> Result<EntryChunks> {
    let max_chunk = options
        .max_chunk_bytes
        .unwrap_or(DEFAULT_ZIP_CHUNK_BYTES)
        .max(1);
    if entry.method != 0 && entry.method != 8 {
        return Err(unsupported_method(entry.method));
    }
    let data_offset = data_offset_of(source, entry)?;
    let failure = SourceFailure::default();
    let range = RangeReader::new(source, data_offset, entry.compressed_size, &failure);

    let reader = if entry.method == 0 {
        // Stored: the file *is* the output, so it is read straight out at the caller's chunk size
        // and never passes through an inflater at all.
        assert_declared_size(entry.compressed_size, entry.uncompressed_size)?;
        ChunkReader::Stored(range)
    } else {
        ChunkReader::Deflated {
            decoder: Box::new(DeflateDecoder::new(BufReader::with_capacity(
                COMPRESSED_SLICE_BYTES,
                range,
            ))),
            failure,
        }
    };
    // One more byte than the entry declares, so an overlong entry is seen as overlong rather than
    // exactly full; never more than the caller's bound.
    let len = usize::try_from(entry.uncompressed_size.saturating_add(1))
        .unwrap_or(usize::MAX)
        .clamp(1, max_chunk);
    Ok(EntryChunks {
        buffer: vec![0u8; len],
        declared: entry.uncompressed_size,
        produced: 0,
        finished: false,
        reader,
    })
}

impl EntryChunks {
    /// Reads until the buffer is full or the entry ends; returns how many bytes it holds.
    fn fill(&mut self) -> Result<usize> {
        let mut filled = 0;
        while filled < self.buffer.len() {
            let slot = &mut self.buffer[filled..];
            let step = match &mut self.reader {
                ChunkReader::Stored(range) => range.read(slot).map_err(source_error),
                ChunkReader::Deflated { decoder, failure } => {
                    decoder.read(slot).map_err(|error| failure.explain(&error))
                }
            };
            match step? {
                0 => {
                    self.finished = true;
                    break;
                }
                n => filled += n,
            }
        }
        Ok(filled)
    }
}

impl ChunkSource for EntryChunks {
    fn pull_chunk(&mut self) -> Result<Option<&[u8]>> {
        if self.finished {
            return Ok(None);
        }
        let filled = match self.fill() {
            Ok(filled) => filled,
            Err(error) => {
                self.finished = true;
                return Err(error);
            }
        };
        self.produced += filled as u64;
        // Checked as it is produced rather than only at the end, so a bomb is refused after one
        // chunk over the declaration instead of after the whole output. The same contract as the
        // buffered path: what comes out has to be what the central directory declared.
        if self.produced > self.declared || (self.finished && self.produced != self.declared) {
            self.finished = true;
            return Err(assert_declared_size(self.produced, self.declared).unwrap_err());
        }
        if filled == 0 {
            return Ok(None);
        }
        Ok(Some(&self.buffer[..filled]))
    }
}

impl Iterator for EntryChunks {
    type Item = Result<Vec<u8>>;

    /// An owned copy of the next chunk, for a consumer that keeps more than one.
    fn next(&mut self) -> Option<Self::Item> {
        match self.pull_chunk() {
            Ok(Some(chunk)) => Some(Ok(chunk.to_vec())),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        }
    }
}
