//! Archive builders for the file-handling tests, ported from the legacy `make-3mf.ts` and
//! `patch-zip.ts`. Archives are generated at test time rather than checked in, so every shape a
//! test relies on is written down next to the test that relies on it.

#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::Path;

use flate2::Compression;
use flate2::write::DeflateEncoder;
use spm_core::files::zip_write::{
    ZipCentralFields, ZipCommonFields, central_header_bytes, crc32, end_of_central_directory_bytes,
    local_header_bytes,
};

pub const MODEL_XML: &str = r#"<?xml version="1.0"?><model unit="millimeter"><resources/></model>"#;

const U32_MAX: u32 = 0xffff_ffff;
const U16_MAX: u16 = 0xffff;

#[derive(Debug, Clone)]
pub struct ZipInput {
    pub name: String,
    pub data: Vec<u8>,
    pub deflate: bool,
}

/// An entry written stored.
pub fn stored(name: &str, data: impl AsRef<[u8]>) -> ZipInput {
    ZipInput {
        name: name.to_owned(),
        data: data.as_ref().to_vec(),
        deflate: false,
    }
}

/// An entry written deflated.
pub fn deflated(name: &str, data: impl AsRef<[u8]>) -> ZipInput {
    ZipInput {
        deflate: true,
        ..stored(name, data)
    }
}

/// Which parts of the archive are written in zip64 form.
///
/// Split into independent switches rather than one "zip64" flag because that is exactly the
/// property the reader has to get right: a zip64 value is authoritative only where its base field
/// says `0xffffffff`, and the failure mode of getting it wrong (reading the extra field
/// unconditionally, or in the wrong order) is a *plausible* wrong offset rather than a crash. The
/// 28 zip64 files in the reference library saturate the EOCD's directory offset and every entry's
/// sizes and offset, while leaving a real 16-bit entry count and a real 32-bit directory size
/// beside them, so `saturate_cd_offset` + `saturate_entries` reproduces the real shape and each
/// other switch exists to pin one field's gate on its own.
#[derive(Debug, Clone, Copy, Default)]
pub struct Zip64Options {
    /// Emit the zip64 end-of-central-directory record and its locator.
    pub end: bool,
    /// Write `0xffffffff` for the EOCD's central-directory offset.
    pub saturate_cd_offset: bool,
    /// Write `0xffffffff` for the EOCD's central-directory size.
    pub saturate_cd_size: bool,
    /// Write `0xffff` for the EOCD's entry count.
    pub saturate_total: bool,
    /// Write `0xffffffff` for each entry's compressed size, uncompressed size and local header
    /// offset, and put the real values in a zip64 extended information extra field.
    pub saturate_entries: bool,
    /// Saturate each entry's local header offset *only*, so its zip64 extra field holds one
    /// 64-bit word. This is the case that catches a reader which takes the words positionally
    /// without consulting the base record: the first word here is the offset, not the
    /// uncompressed size.
    pub saturate_entry_offset_only: bool,
}

fn deflate_raw(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

pub fn write_zip(path: &Path, entries: &[ZipInput], zip64: Option<Zip64Options>) {
    let zip64 = zip64.unwrap_or_default();
    let mut body: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();

    for entry in entries {
        let raw = &entry.data;
        let method: u16 = if entry.deflate { 8 } else { 0 };
        let payload = if entry.deflate {
            deflate_raw(raw)
        } else {
            raw.clone()
        };
        let name = entry.name.as_bytes().to_vec();
        let checksum = crc32(raw);
        let offset = body.len() as u64;

        body.extend(local_header_bytes(&ZipCommonFields {
            version_needed: 20,
            flags: 0,
            method,
            mod_time: 0,
            mod_date: 0,
            crc: checksum,
            compressed_size: payload.len() as u32,
            uncompressed_size: raw.len() as u32,
            name: name.clone(),
            extra: Vec::new(),
        }));
        body.extend(&payload);

        // The zip64 extended information extra field is positional: uncompressed size, then
        // compressed size, then local header offset, and only for the fields the base record
        // saturated. All three are saturated together here, which is what a real producer does.
        let words = if zip64.saturate_entries {
            3
        } else if zip64.saturate_entry_offset_only {
            1
        } else {
            0
        };
        let mut extra = Vec::new();
        if words > 0 {
            extra.extend(1u16.to_le_bytes());
            extra.extend((words as u16 * 8).to_le_bytes());
            if words == 3 {
                extra.extend((raw.len() as u64).to_le_bytes());
                extra.extend((payload.len() as u64).to_le_bytes());
                extra.extend(offset.to_le_bytes());
            } else {
                extra.extend(offset.to_le_bytes());
            }
        }
        // 4.5 ("45") is the version that introduced zip64; a plain archive keeps the 2.0 it
        // always claimed.
        let version = if words == 0 { 20 } else { 45 };
        central.extend(central_header_bytes(&ZipCentralFields {
            common: ZipCommonFields {
                version_needed: version,
                flags: 0,
                method,
                mod_time: 0,
                mod_date: 0,
                crc: checksum,
                compressed_size: if zip64.saturate_entries {
                    U32_MAX
                } else {
                    payload.len() as u32
                },
                uncompressed_size: if zip64.saturate_entries {
                    U32_MAX
                } else {
                    raw.len() as u32
                },
                name,
                extra,
            },
            version_made_by: version,
            internal_attributes: 0,
            external_attributes: 0,
            local_header_offset: if words == 0 { offset as u32 } else { U32_MAX },
        }));
    }

    let offset = body.len() as u64;
    let mut tail: Vec<u8> = Vec::new();
    if zip64.end {
        let mut record = vec![0u8; 56];
        record[0..4].copy_from_slice(&0x0606_4b50u32.to_le_bytes());
        record[4..12].copy_from_slice(&(56u64 - 12).to_le_bytes()); // size of the record after this field
        record[12..14].copy_from_slice(&45u16.to_le_bytes());
        record[14..16].copy_from_slice(&45u16.to_le_bytes());
        record[24..32].copy_from_slice(&(entries.len() as u64).to_le_bytes());
        record[32..40].copy_from_slice(&(entries.len() as u64).to_le_bytes());
        record[40..48].copy_from_slice(&(central.len() as u64).to_le_bytes());
        record[48..56].copy_from_slice(&offset.to_le_bytes());

        let mut locator = vec![0u8; 20];
        locator[0..4].copy_from_slice(&0x0706_4b50u32.to_le_bytes());
        locator[8..16].copy_from_slice(&(offset + central.len() as u64).to_le_bytes());
        locator[16..20].copy_from_slice(&1u32.to_le_bytes());

        tail.extend(record);
        tail.extend(locator);
    }
    tail.extend(end_of_central_directory_bytes(
        if zip64.saturate_total {
            U16_MAX
        } else {
            entries.len() as u16
        },
        if zip64.saturate_cd_size {
            U32_MAX
        } else {
            central.len() as u32
        },
        if zip64.saturate_cd_offset {
            U32_MAX
        } else {
            offset as u32
        },
    ));

    let mut out = body;
    out.extend(central);
    out.extend(tail);
    fs::write(path, out).unwrap();
}

/// A slice_info.config carrying the given header-item keys, values deliberately junk.
pub fn slice_info(keys: &[&str]) -> String {
    let items = keys
        .iter()
        .map(|key| format!("    <header_item key=\"{key}\" value=\"whatever\"/>"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n  <header>\n{items}\n  </header>\n  <plate>\n    <metadata key=\"printer_model_id\" value=\"Anycubic Kobra X\"/>\n  </plate>\n</config>\n"
    )
}

pub fn cura_project(path: &Path, thumbnail: Option<&[u8]>) {
    let mut entries = vec![
        stored("[Content_Types].xml", "<Types/>"),
        deflated("3D/3dmodel.model", MODEL_XML),
        stored("Cura/plugin_metadata.json", "{}"),
        stored("Cura/preferences.cfg", "[general]"),
    ];
    entries.extend(thumbnail.map(|bytes| stored("Metadata/thumbnail.png", bytes)));
    write_zip(path, &entries, None);
}

pub fn prusa_project(path: &Path, thumbnail: Option<&[u8]>) {
    let mut entries = vec![
        deflated("3D/3dmodel.model", MODEL_XML),
        stored("Metadata/Slic3r_PE.config", "; generated by PrusaSlicer"),
        stored("Metadata/Slic3r_PE_model.config", "<config/>"),
    ];
    entries.extend(thumbnail.map(|bytes| stored("Metadata/thumbnail.png", bytes)));
    write_zip(path, &entries, None);
}

/// Anycubic, Bambu and Orca share this layout exactly; only the header keys differ.
pub fn bambu_lineage_project(path: &Path, header_keys: &[&str], thumbnail: Option<&[u8]>) {
    let mut entries = vec![
        deflated("3D/3dmodel.model", MODEL_XML),
        stored(
            "Metadata/project_settings.config",
            r#"{"version": "02.08.02.61"}"#,
        ),
        stored("Metadata/model_settings.config", "<config/>"),
        stored("Metadata/slice_info.config", slice_info(header_keys)),
    ];
    if let Some(bytes) = thumbnail {
        entries.push(stored("Metadata/plate_1.png", bytes));
        entries.push(stored("Metadata/plate_1_small.png", bytes));
        entries.push(stored("Metadata/top_1.png", bytes));
    }
    write_zip(path, &entries, None);
}

/// Saved but never sliced, so slice_info.config was never written (spec 3.4, rule 4).
pub fn unsliced_bambu_project(path: &Path) {
    write_zip(
        path,
        &[
            deflated("3D/3dmodel.model", MODEL_XML),
            stored(
                "Metadata/project_settings.config",
                r#"{"version": "02.06.00.51"}"#,
            ),
            stored("Metadata/model_settings.config", "<config/>"),
        ],
        None,
    );
}

pub fn plain_mesh_3mf(path: &Path) {
    write_zip(
        path,
        &[
            stored("[Content_Types].xml", "<Types/>"),
            deflated("3D/3dmodel.model", MODEL_XML),
        ],
        None,
    );
}

// ---------------------------------------------------------------------------------------------
// post-hoc surgery on an archive `write_zip` already wrote (legacy `patch-zip.ts`)
// ---------------------------------------------------------------------------------------------
//
// Separate from the builder on purpose: the builder writes well-formed archives, these produce
// archives no writer here would emit (general-purpose flags a `write_zip` caller cannot set,
// wall-clock timestamps, a central directory whose order disagrees with the file's), which is
// exactly what the rewriter and the change detector have to be right about.
//
// Non-zip64 inputs only, and no archive comment: the end-of-central-directory record is the last
// 22 bytes of the file.

const CD_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const CD_MIN: usize = 46;
const EOCD_MIN: usize = 22;

pub fn get_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

pub fn get_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

pub fn set_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

pub fn set_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

pub fn set_u64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

pub struct ZipHeaderPatch<'a> {
    pub name: String,
    /// The whole file; writes through it land in the file when the patch returns.
    pub file: &'a mut [u8],
    /// Offset of this entry's central directory record.
    pub central_at: usize,
    /// Offset of this entry's local file header.
    pub local_at: usize,
}

struct CentralRecord {
    name: String,
    at: usize,
    length: usize,
}

fn central_records(bytes: &[u8]) -> Vec<CentralRecord> {
    let eocd_at = bytes.len() - EOCD_MIN;
    assert_eq!(
        get_u32(bytes, eocd_at),
        EOCD_SIG,
        "patch-zip expects an archive with no comment and no zip64 records"
    );
    let total = get_u16(bytes, eocd_at + 10);
    let mut at = get_u32(bytes, eocd_at + 16) as usize;
    let mut records = Vec::new();
    for _ in 0..total {
        assert_eq!(get_u32(bytes, at), CD_SIG, "corrupt central directory");
        let name_length = usize::from(get_u16(bytes, at + 28));
        let length = CD_MIN
            + name_length
            + usize::from(get_u16(bytes, at + 30))
            + usize::from(get_u16(bytes, at + 32));
        records.push(CentralRecord {
            name: String::from_utf8_lossy(&bytes[at + CD_MIN..at + CD_MIN + name_length])
                .into_owned(),
            at,
            length,
        });
        at += length;
    }
    records
}

/// Calls `edit` once per entry, in central-directory order, then writes the file back.
pub fn patch_zip_headers(path: &Path, mut edit: impl FnMut(&mut ZipHeaderPatch)) {
    let mut bytes = fs::read(path).unwrap();
    for record in central_records(&bytes) {
        let local_at = get_u32(&bytes, record.at + 42) as usize;
        edit(&mut ZipHeaderPatch {
            name: record.name,
            file: &mut bytes,
            central_at: record.at,
            local_at,
        });
    }
    fs::write(path, bytes).unwrap();
}

/// Reverses the order of the central directory's records, leaving every local header and payload
/// exactly where it was.
///
/// The result is a perfectly legal archive whose directory order is the opposite of its physical
/// order: the shape that catches a rewriter emitting entries in the order it read them rather than
/// the order they lie in, which is how `[Content_Types].xml` silently stops being first.
pub fn reverse_central_directory(path: &Path) {
    let mut bytes = fs::read(path).unwrap();
    let eocd_at = bytes.len() - EOCD_MIN;
    let cd_offset = get_u32(&bytes, eocd_at + 16) as usize;
    let records: Vec<Vec<u8>> = central_records(&bytes)
        .iter()
        .map(|record| bytes[record.at..record.at + record.length].to_vec())
        .collect();
    let mut at = cd_offset;
    for record in records.iter().rev() {
        bytes[at..at + record.len()].copy_from_slice(record);
        at += record.len();
    }
    fs::write(path, bytes).unwrap();
}
