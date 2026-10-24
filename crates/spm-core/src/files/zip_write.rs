//! The ZIP *writer* side, beside the reader in [`super::zip`]. Desktop only (feature `desktop`).
//!
//! Two things live here and they are deliberately in one file:
//!
//! 1. **The header layouts and the CRC-32.** The test fixtures build archives from scratch with
//!    fresh compression, and [`rewrite_zip`] rewrites existing ones without touching their
//!    payloads: different jobs, but the same three records on the wire and the same CRC
//!    polynomial. The repo has one table and one layout to keep right.
//! 2. **[`rewrite_zip`]**, an entry-preserving rewriter: drop some entries, replace the bytes of
//!    others, copy the rest **compressed-bytes-verbatim**, and emit a fresh directory around what
//!    survives.
//!
//! # What a rewritten archive keeps, and what it does not
//!
//! Kept, per entry: the name, the compression method and the compressed bytes exactly as they lay
//! in the input, the CRC-32, the DOS modification time and date, the version-made-by /
//! version-needed pair, the internal and external attribute words, and every general-purpose flag
//! bit except bit 3.
//!
//! **Not kept, and this is a decision rather than an oversight:**
//!
//! * **Extra fields.** An input extra field can be a zip64 extended-information record, and this
//!   writer emits a non-zip64 directory, so carrying extras across unfiltered would leave a record
//!   contradicting the base fields beside it. Dropping all of them is the only rule that is right
//!   for every input. The cost is the high-resolution timestamp extras some writers add; the DOS
//!   timestamp in the record proper survives, and nothing in this system reads either.
//! * **Entry comments** and **the archive comment.** No 3MF writer emits one.
//!
//! # Order
//!
//! Surviving entries are emitted in **ascending input local-header offset**: the order the entries
//! physically lay in the input file, which is not necessarily central-directory order. That is
//! what makes "`[Content_Types].xml` stays first" true rather than hoped for: OPC requires the
//! content-types item to be the first item in the package, and it is first *positionally*.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use serde_json::{Map, Value};

use super::fsio::read_exact_at;
use super::zip::{ZipEntry, read_zip_entries};
use crate::error::{AppError, Result};

const LOCAL_SIG: u32 = 0x0403_4b50;
const CD_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const LOCAL_MIN: u64 = 30;
const CD_MIN: u64 = 46;
/// Bit 0: the entry is encrypted. Refused: this writer cannot reproduce what it cannot read.
const FLAG_ENCRYPTED: u16 = 1 << 0;
/// Bit 3: sizes and CRC live in a data descriptor after the payload. Cleared; see [`rewrite_zip`].
const FLAG_DATA_DESCRIPTOR: u16 = 1 << 3;
const U32_MAX: u64 = 0xffff_ffff;
/// `0xffff` in the EOCD's entry count is the "read the zip64 record instead" sentinel, so an
/// archive with exactly that many entries is not representable by a non-zip64 EOCD even though the
/// field is wide enough to hold the number.
const MAX_NON_ZIP64_ENTRIES: usize = 0xffff - 1;
/// One linear copy, a megabyte at a time; nothing here holds a whole entry in memory.
const COPY_CHUNK_BYTES: usize = 1 << 20;

/// CRC-32 (IEEE) of `bytes`.
pub fn crc32(bytes: &[u8]) -> u32 {
    crc32fast::hash(bytes)
}

/// The fields a local file header and a central directory record share, in wire order.
#[derive(Debug, Clone, Default)]
pub struct ZipCommonFields {
    pub version_needed: u16,
    pub flags: u16,
    pub method: u16,
    pub mod_time: u16,
    pub mod_date: u16,
    pub crc: u32,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
    pub name: Vec<u8>,
    /// Written verbatim after the name. [`rewrite_zip`] never emits one; test fixtures' zip64 does.
    pub extra: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct ZipCentralFields {
    pub common: ZipCommonFields,
    pub version_made_by: u16,
    pub internal_attributes: u16,
    pub external_attributes: u32,
    pub local_header_offset: u32,
}

fn put_u16(out: &mut [u8], at: usize, value: u16) {
    out[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut [u8], at: usize, value: u32) {
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// A local file header. Callers pass the values they want on the wire, saturation sentinels
/// included: this function is a layout, not a policy.
pub fn local_header_bytes(fields: &ZipCommonFields) -> Vec<u8> {
    let name = fields.name.len();
    let mut out = vec![0u8; LOCAL_MIN as usize + name + fields.extra.len()];
    put_u32(&mut out, 0, LOCAL_SIG);
    put_u16(&mut out, 4, fields.version_needed);
    put_u16(&mut out, 6, fields.flags);
    put_u16(&mut out, 8, fields.method);
    put_u16(&mut out, 10, fields.mod_time);
    put_u16(&mut out, 12, fields.mod_date);
    put_u32(&mut out, 14, fields.crc);
    put_u32(&mut out, 18, fields.compressed_size);
    put_u32(&mut out, 22, fields.uncompressed_size);
    put_u16(&mut out, 26, fields.name.len() as u16);
    put_u16(&mut out, 28, fields.extra.len() as u16);
    out[30..30 + name].copy_from_slice(&fields.name);
    out[30 + name..].copy_from_slice(&fields.extra);
    out
}

/// A central directory record. Same contract as [`local_header_bytes`]: layout, not policy.
pub fn central_header_bytes(fields: &ZipCentralFields) -> Vec<u8> {
    let common = &fields.common;
    let name = common.name.len();
    let mut out = vec![0u8; CD_MIN as usize + name + common.extra.len()];
    put_u32(&mut out, 0, CD_SIG);
    put_u16(&mut out, 4, fields.version_made_by);
    put_u16(&mut out, 6, common.version_needed);
    put_u16(&mut out, 8, common.flags);
    put_u16(&mut out, 10, common.method);
    put_u16(&mut out, 12, common.mod_time);
    put_u16(&mut out, 14, common.mod_date);
    put_u32(&mut out, 16, common.crc);
    put_u32(&mut out, 20, common.compressed_size);
    put_u32(&mut out, 24, common.uncompressed_size);
    put_u16(&mut out, 28, name as u16);
    put_u16(&mut out, 30, common.extra.len() as u16);
    put_u16(&mut out, 36, fields.internal_attributes);
    put_u32(&mut out, 38, fields.external_attributes);
    put_u32(&mut out, 42, fields.local_header_offset);
    out[46..46 + name].copy_from_slice(&common.name);
    out[46 + name..].copy_from_slice(&common.extra);
    out
}

/// A non-zip64 end-of-central-directory record, with no archive comment.
pub fn end_of_central_directory_bytes(total: u16, cd_size: u32, cd_offset: u32) -> Vec<u8> {
    let mut out = vec![0u8; 22];
    put_u32(&mut out, 0, EOCD_SIG);
    put_u16(&mut out, 8, total);
    put_u16(&mut out, 10, total);
    put_u32(&mut out, 12, cd_size);
    put_u32(&mut out, 16, cd_offset);
    out
}

/// What to change in a copy.
#[derive(Debug, Clone, Default)]
pub struct ZipRewrite {
    /// Entry names to leave out. A name that is not in the archive is not an error.
    pub drop: HashSet<String>,
    /// Entry names whose payload is replaced. The replacement is written **stored**, with a
    /// **recomputed** CRC-32 and fresh sizes: carrying the original CRC across is the easy
    /// mistake, and it produces an archive most readers open happily until one does not. A name
    /// that is not in the archive **is** an error: silently writing nothing is how a typo
    /// survives review.
    pub replace: HashMap<String, Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipRewriteResult {
    /// Names written, in output (= input positional) order.
    pub kept: Vec<String>,
    /// Names present in the input and left out, in input positional order.
    pub dropped: Vec<String>,
    /// Names whose bytes were replaced, in input positional order.
    pub replaced: Vec<String>,
}

fn refusal(reason: &str, message: &str, extra: &[(&str, Value)]) -> AppError {
    let mut details = Map::new();
    details.insert("reason".into(), Value::from(reason));
    for (key, value) in extra {
        details.insert((*key).to_owned(), value.clone());
    }
    AppError::validation(message).with_details(details)
}

struct PlannedEntry<'a> {
    source: &'a ZipEntry,
    fields: ZipCentralFields,
    replacement: Option<&'a [u8]>,
}

/// Writes a copy of `input` at `output` with `rewrite` applied.
///
/// Surviving entries keep their compressed bytes byte-for-byte: no decompress/recompress round
/// trip, stored and deflated alike, and the whole operation costs one linear copy of the parts
/// that survive, a megabyte at a time.
///
/// **General-purpose flags.** Bit 3 is cleared, because this writer puts real sizes in the local
/// header and emits no data descriptor. It can do that for *any* input, descriptor-bearing ones
/// included, because the sizes come from the central directory, which carries them whether or not
/// the local header did. Bit 11 (UTF-8 names) and every other bit are copied, since they describe
/// the bytes being copied.
///
/// **zip64.** The output is always non-zip64. That is a capability, not a limitation: the zip64
/// files in the reference library run 1,620 B to 7.75 MB, so every size, offset and count fits its
/// 32- or 16-bit field with room to spare.
///
/// **Refusals**, all `Validation` errors with a `reason` in `details`. Two of the four names,
/// `encrypted` and `unreadable`, are `strip3mf`'s own reasons by design, so those travel to the
/// user unchanged. The other two are flattened by it: `unrepresentable` reaches the user as
/// `unreadable`, and `invalid-request` is unreachable from `strip3mf` at all.
///
/// * `encrypted`: an entry with general-purpose bit 0 set (a strong-encryption entry sets it too).
/// * `unrepresentable`: a value that genuinely does not fit the non-zip64 form: an entry or
///   directory over 4 GiB - 1, an output offset past it, 65,535 entries or more, or a name longer
///   than a 16-bit length.
/// * `unreadable`: the input is broken: a local header with no signature, or a short read.
/// * `invalid-request`: a `replace` key naming an entry the archive does not have. The only one
///   about the *call* rather than the *file*.
///
/// Every check that can run before the output file exists does, so most refusals leave nothing
/// behind; a failure *during* the copy removes what it had written.
pub fn rewrite_zip(input: &Path, output: &Path, rewrite: &ZipRewrite) -> Result<ZipRewriteResult> {
    // Positional order, not central-directory order. This is the whole of the
    // "[Content_Types].xml stays first" guarantee.
    let mut entries = read_zip_entries(input)?;
    entries.sort_by_key(|entry| entry.local_header_offset);

    let known: HashSet<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    let mut unknown: Vec<&String> = rewrite
        .replace
        .keys()
        .filter(|name| !known.contains(name.as_str()))
        .collect();
    unknown.sort();
    if let Some(name) = unknown.first() {
        return Err(refusal(
            "invalid-request",
            "replacement names an entry the archive does not have",
            &[("entry", Value::from(name.as_str()))],
        ));
    }

    let mut dropped = Vec::new();
    let mut replaced = Vec::new();
    let mut plan: Vec<PlannedEntry> = Vec::new();
    let mut offset: u64 = 0;

    for entry in &entries {
        if rewrite.drop.contains(&entry.name) {
            dropped.push(entry.name.clone());
            continue;
        }
        if entry.flags & FLAG_ENCRYPTED != 0 {
            return Err(refusal(
                "encrypted",
                "zip entry is encrypted",
                &[("entry", Value::from(entry.name.as_str()))],
            ));
        }

        let replacement = rewrite.replace.get(&entry.name).map(Vec::as_slice);
        if replacement.is_some() {
            replaced.push(entry.name.clone());
        }
        let (compressed_size, uncompressed_size) = match replacement {
            Some(bytes) => (bytes.len() as u64, bytes.len() as u64),
            None => (entry.compressed_size, entry.uncompressed_size),
        };
        // `>=`, not `>`. `0xffffffff` is the "look in the zip64 record instead" sentinel, so a
        // value that happens to be exactly that is *not* representable by a plain record even
        // though the field is wide enough to hold it: writing it would send a reader looking for
        // an extra field this writer does not emit.
        if compressed_size >= U32_MAX
            || uncompressed_size >= U32_MAX
            || offset >= U32_MAX
            || entry.name.len() > usize::from(u16::MAX)
        {
            return Err(refusal(
                "unrepresentable",
                "zip entry is too large for a non-zip64 directory",
                &[("entry", Value::from(entry.name.as_str()))],
            ));
        }
        let name = entry.name.as_bytes().to_vec();
        let name_length = name.len() as u64;
        let fields = ZipCentralFields {
            common: ZipCommonFields {
                version_needed: entry.version_needed,
                // Bit 3 goes; everything else, bit 11 included, describes bytes we are copying
                // unchanged.
                flags: entry.flags & !FLAG_DATA_DESCRIPTOR,
                method: if replacement.is_some() {
                    0
                } else {
                    entry.method
                },
                mod_time: entry.mod_time,
                mod_date: entry.mod_date,
                crc: replacement.map_or(entry.crc, crc32),
                compressed_size: compressed_size as u32,
                uncompressed_size: uncompressed_size as u32,
                name,
                extra: Vec::new(),
            },
            version_made_by: entry.version_made_by,
            internal_attributes: entry.internal_attributes,
            external_attributes: entry.external_attributes,
            local_header_offset: offset as u32,
        };
        plan.push(PlannedEntry {
            source: entry,
            fields,
            replacement,
        });
        offset += LOCAL_MIN + name_length + compressed_size;
    }

    if plan.len() > MAX_NON_ZIP64_ENTRIES {
        return Err(refusal(
            "unrepresentable",
            "too many zip entries for a non-zip64 directory",
            &[("total", Value::from(plan.len()))],
        ));
    }
    let central: Vec<Vec<u8>> = plan
        .iter()
        .map(|planned| central_header_bytes(&planned.fields))
        .collect();
    let cd_size: u64 = central.iter().map(|record| record.len() as u64).sum();
    if offset >= U32_MAX || cd_size >= U32_MAX {
        return Err(refusal(
            "unrepresentable",
            "zip is too large for a non-zip64 directory",
            &[
                ("cdOffset", Value::from(offset)),
                ("cdSize", Value::from(cd_size)),
            ],
        ));
    }

    let end = end_of_central_directory_bytes(plan.len() as u16, cd_size as u32, offset as u32);
    write_archive(input, output, &plan, &central, &end)?;
    Ok(ZipRewriteResult {
        kept: plan
            .iter()
            .map(|planned| planned.source.name.clone())
            .collect(),
        dropped,
        replaced,
    })
}

fn write_archive(
    input: &Path,
    output: &Path,
    plan: &[PlannedEntry],
    central: &[Vec<u8>],
    end: &[u8],
) -> Result<()> {
    let source = File::open(input)?;
    let size = source.metadata()?.len();
    let mut out = BufWriter::new(File::create(output)?);
    let written = (|| -> Result<()> {
        for planned in plan {
            out.write_all(&local_header_bytes(&planned.fields.common))?;
            match planned.replacement {
                Some(bytes) => out.write_all(bytes)?,
                None => copy_entry_data(&source, size, &mut out, planned.source)?,
            }
        }
        for record in central {
            out.write_all(record)?;
        }
        out.write_all(end)?;
        out.flush()?;
        Ok(())
    })();
    if let Err(error) = written {
        // A half-written archive is worse than none: the next step re-classifies the output, and
        // a truncated file would classify `other` and be reported as the wrong kind of failure.
        drop(out);
        let _ = fs::remove_file(output);
        return Err(error);
    }
    Ok(())
}

/// Copies one entry's compressed payload across, a bounded slice at a time.
fn copy_entry_data(source: &File, size: u64, out: &mut impl Write, entry: &ZipEntry) -> Result<()> {
    let unreadable = |message: &str| {
        refusal(
            "unreadable",
            message,
            &[("entry", Value::from(entry.name.as_str()))],
        )
    };
    let from = data_offset_of(source, size, entry)?;
    if from
        .checked_add(entry.compressed_size)
        .is_none_or(|end| end > size)
    {
        return Err(unreadable("unexpected end of zip file"));
    }
    let chunk = usize::try_from(entry.compressed_size)
        .unwrap_or(COPY_CHUNK_BYTES)
        .clamp(1, COPY_CHUNK_BYTES);
    let mut buffer = vec![0u8; chunk];
    let mut at = 0u64;
    while at < entry.compressed_size {
        let length = (entry.compressed_size - at).min(buffer.len() as u64) as usize;
        read_exact_at(source, &mut buffer[..length], from + at)
            .map_err(|_| unreadable("unexpected end of zip file"))?;
        out.write_all(&buffer[..length])?;
        at += length as u64;
    }
    Ok(())
}

/// Where an entry's data starts. The local header's own name and extra lengths are read rather
/// than the central directory's copy, because the two routinely differ.
fn data_offset_of(source: &File, size: u64, entry: &ZipEntry) -> Result<u64> {
    let unreadable = |message: &str| {
        refusal(
            "unreadable",
            message,
            &[("entry", Value::from(entry.name.as_str()))],
        )
    };
    let at = entry.local_header_offset;
    if at.checked_add(LOCAL_MIN).is_none_or(|end| end > size) {
        return Err(unreadable("unexpected end of zip file"));
    }
    let mut header = [0u8; LOCAL_MIN as usize];
    read_exact_at(source, &mut header, at).map_err(|_| unreadable("unexpected end of zip file"))?;
    let word = |at: usize| {
        u32::from_le_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]])
    };
    if word(0) != LOCAL_SIG {
        // A local header that does not start with its own signature is a broken *file*, not a
        // value this writer cannot express, so it reports the reason a user can act on.
        return Err(unreadable("corrupt zip local header"));
    }
    let name_length = u64::from(u16::from_le_bytes([header[26], header[27]]));
    let extra_length = u64::from(u16::from_le_bytes([header[28], header[29]]));
    Ok(at + LOCAL_MIN + name_length + extra_length)
}
