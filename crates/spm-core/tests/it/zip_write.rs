//! Ports `zip-write.test.ts`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use spm_core::files::zip::{ZipEntry, read_zip_entries, read_zip_entry_bytes};
use spm_core::files::zip_write::{ZipRewrite, crc32, rewrite_zip};
use spm_core::{AppError, AppErrorCode};
use tempfile::tempdir;

use crate::fixtures::{
    MODEL_XML, Zip64Options, ZipInput, deflated, get_u16, get_u32, patch_zip_headers,
    reverse_central_directory, set_u16, set_u32, set_u64, stored, write_zip,
};

const FLAG_ENCRYPTED: u16 = 1 << 0;
const FLAG_DATA_DESCRIPTOR: u16 = 1 << 3;
const FLAG_UTF8: u16 = 1 << 11;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;

/// Three entries: one stored, one deflated, one binary, and content types first.
fn sample() -> Vec<ZipInput> {
    vec![
        stored("[Content_Types].xml", "<Types/>"),
        deflated("3D/3dmodel.model", MODEL_XML),
        stored("Metadata/stored.txt", "stored verbatim, no deflate"),
    ]
}

fn names(entries: &[ZipEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

fn reason_of(error: &AppError) -> Option<&str> {
    assert_eq!(error.code, AppErrorCode::Validation);
    error.details.as_ref()?.get("reason")?.as_str()
}

/// The compressed bytes of one entry, straight out of the file, past its own local header.
fn compressed_bytes(path: &Path, entry: &ZipEntry) -> Vec<u8> {
    let bytes = fs::read(path).unwrap();
    let at = entry.local_header_offset as usize;
    let start =
        at + 30 + usize::from(get_u16(&bytes, at + 26)) + usize::from(get_u16(&bytes, at + 28));
    bytes[start..start + entry.compressed_size as usize].to_vec()
}

#[derive(Debug, PartialEq, Eq)]
struct LocalHeader {
    flags: u16,
    method: u16,
    crc: u32,
    compressed_size: u32,
    uncompressed_size: u32,
}

/// The local file header's own copy of the fields the central directory also carries.
fn local_header_of(path: &Path, entry: &ZipEntry) -> LocalHeader {
    let bytes = fs::read(path).unwrap();
    let at = entry.local_header_offset as usize;
    LocalHeader {
        flags: get_u16(&bytes, at + 6),
        method: get_u16(&bytes, at + 8),
        crc: get_u32(&bytes, at + 14),
        compressed_size: get_u32(&bytes, at + 18),
        uncompressed_size: get_u32(&bytes, at + 22),
    }
}

fn find<'a>(entries: &'a [ZipEntry], name: &str) -> &'a ZipEntry {
    entries
        .iter()
        .find(|candidate| candidate.name == name)
        .unwrap_or_else(|| panic!("no entry {name}"))
}

fn dropping(names: &[&str]) -> ZipRewrite {
    ZipRewrite {
        drop: names.iter().map(|name| (*name).to_owned()).collect(),
        replace: HashMap::new(),
    }
}

fn replacing(name: &str, bytes: &[u8]) -> ZipRewrite {
    ZipRewrite {
        drop: HashSet::new(),
        replace: HashMap::from([(name.to_owned(), bytes.to_vec())]),
    }
}

#[test]
fn a_zip64_input_whose_values_fit_produces_a_readable_non_zip64_output() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // The shape the reference library's 28 zip64 files actually have: a saturated directory
    // offset and saturated per-entry sizes, over payloads of a few kilobytes.
    write_zip(
        &input,
        &sample(),
        Some(Zip64Options {
            end: true,
            saturate_cd_offset: true,
            saturate_entries: true,
            ..Zip64Options::default()
        }),
    );
    let before = read_zip_entries(&input).unwrap();

    rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap();

    let after = read_zip_entries(&output).unwrap();
    let summary = |entries: &[ZipEntry]| {
        entries
            .iter()
            .map(|e| {
                format!(
                    "{} m{} c{} u{}",
                    e.name, e.method, e.compressed_size, e.uncompressed_size
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(summary(&after), summary(&before));
    // Not merely "it parses": the zip64 records are gone from the bytes entirely.
    let bytes = fs::read(&output).unwrap();
    for at in 0..=bytes.len() - 4 {
        let signature = get_u32(&bytes, at);
        assert_ne!(signature, ZIP64_EOCD_SIG);
        assert_ne!(signature, ZIP64_LOCATOR_SIG);
    }
    let model = read_zip_entry_bytes(&output, find(&after, "3D/3dmodel.model")).unwrap();
    assert_eq!(String::from_utf8(model).unwrap(), MODEL_XML);
}

#[test]
fn surviving_entries_keep_their_compressed_bytes_verbatim_stored_and_deflated_alike() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    rewrite_zip(&input, &output, &dropping(&["[Content_Types].xml"])).unwrap();

    let before = read_zip_entries(&input).unwrap();
    let after = read_zip_entries(&output).unwrap();
    for name in ["3D/3dmodel.model", "Metadata/stored.txt"] {
        assert_eq!(
            compressed_bytes(&output, find(&after, name)),
            compressed_bytes(&input, find(&before, name)),
            "{name}"
        );
        assert_eq!(
            read_zip_entry_bytes(&output, find(&after, name)).unwrap(),
            read_zip_entry_bytes(&input, find(&before, name)).unwrap(),
            "{name}"
        );
    }
    assert_eq!(find(&after, "3D/3dmodel.model").method, 8);
    assert_eq!(find(&after, "Metadata/stored.txt").method, 0);
}

#[test]
fn content_types_stays_first_even_when_the_central_directory_disagrees_with_the_file() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    reverse_central_directory(&input);
    // The directory now lists content types last while it still lies first in the file. A
    // rewriter that emitted in the order it read would put it last and break OPC.
    assert_eq!(
        read_zip_entries(&input).unwrap()[0].name,
        "Metadata/stored.txt"
    );

    rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap();

    let after = read_zip_entries(&output).unwrap();
    assert_eq!(after[0].name, "[Content_Types].xml");
    assert_eq!(after[0].local_header_offset, 0);
    assert_eq!(
        names(&after),
        [
            "[Content_Types].xml",
            "3D/3dmodel.model",
            "Metadata/stored.txt"
        ]
    );
}

#[test]
fn the_data_descriptor_bit_is_cleared_the_utf8_bit_survives_and_the_local_header_gets_real_sizes() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    // Bit 3 plus bit 11, and one more bit nobody names, to prove "every other bit is copied".
    let flags = FLAG_DATA_DESCRIPTOR | FLAG_UTF8 | (1 << 1);
    patch_zip_headers(&input, |entry| {
        set_u16(entry.file, entry.central_at + 8, flags);
        set_u16(entry.file, entry.local_at + 6, flags);
    });

    rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap();

    for entry in read_zip_entries(&output).unwrap() {
        assert_eq!(entry.flags, FLAG_UTF8 | (1 << 1), "{}", entry.name);
        let local = local_header_of(&output, &entry);
        assert_eq!(local.flags, entry.flags, "{}", entry.name);
        assert_eq!(local.crc, entry.crc, "{}", entry.name);
        assert_eq!(
            u64::from(local.compressed_size),
            entry.compressed_size,
            "{}",
            entry.name
        );
        assert_eq!(
            u64::from(local.uncompressed_size),
            entry.uncompressed_size,
            "{}",
            entry.name
        );
    }
}

#[test]
fn an_entry_with_the_encryption_bit_set_is_refused_and_no_output_is_left_behind() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    patch_zip_headers(&input, |entry| {
        if entry.name != "Metadata/stored.txt" {
            return;
        }
        set_u16(entry.file, entry.central_at + 8, FLAG_ENCRYPTED);
        set_u16(entry.file, entry.local_at + 6, FLAG_ENCRYPTED);
    });

    let error = rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap_err();
    assert_eq!(reason_of(&error), Some("encrypted"));
    assert!(!output.exists());
}

#[test]
fn replacement_bytes_are_stored_with_a_recomputed_crc_32_and_fresh_sizes() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    let replacement = br#"<Types><Default Extension="png"/></Types>"#;

    let result = rewrite_zip(
        &input,
        &output,
        &replacing("[Content_Types].xml", replacement),
    )
    .unwrap();

    assert_eq!(result.replaced, ["[Content_Types].xml"]);
    let after = read_zip_entries(&output).unwrap();
    let entry = find(&after, "[Content_Types].xml");
    assert_eq!(entry.method, 0);
    assert_eq!(entry.compressed_size, replacement.len() as u64);
    assert_eq!(entry.uncompressed_size, replacement.len() as u64);
    assert_eq!(entry.crc, crc32(replacement));
    // The mistake this exists for: carrying the original CRC across produces a file most readers
    // still open. The two CRCs must actually differ, or the assertion above proves nothing.
    assert_ne!(
        entry.crc,
        find(&read_zip_entries(&input).unwrap(), "[Content_Types].xml").crc
    );
    assert_eq!(read_zip_entry_bytes(&output, entry).unwrap(), replacement);
    assert_eq!(local_header_of(&output, entry).crc, crc32(replacement));
}

#[test]
fn a_deflated_entry_can_be_replaced_and_the_replacement_is_not_left_claiming_method_8() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);

    rewrite_zip(&input, &output, &replacing("3D/3dmodel.model", b"<model/>")).unwrap();

    let after = read_zip_entries(&output).unwrap();
    let entry = find(&after, "3D/3dmodel.model");
    assert_eq!(entry.method, 0);
    assert_eq!(read_zip_entry_bytes(&output, entry).unwrap(), b"<model/>");
}

#[test]
fn a_replacement_naming_an_entry_the_archive_does_not_have_is_refused() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    let error = rewrite_zip(&input, &output, &replacing("Metadata/typo.xml", b"")).unwrap_err();
    // Not `unrepresentable`: this is the call being incoherent, not the archive.
    assert_eq!(reason_of(&error), Some("invalid-request"));
    assert!(!output.exists());
}

#[test]
fn dropping_names_that_are_not_in_the_archive_is_not_an_error() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);

    let result = rewrite_zip(
        &input,
        &output,
        &dropping(&["Metadata/stored.txt", "Metadata/never-existed.config"]),
    )
    .unwrap();

    assert_eq!(result.dropped, ["Metadata/stored.txt"]);
    assert_eq!(result.kept, ["[Content_Types].xml", "3D/3dmodel.model"]);
    assert_eq!(
        names(&read_zip_entries(&output).unwrap()),
        ["[Content_Types].xml", "3D/3dmodel.model"]
    );
}

#[test]
fn an_empty_archive_round_trips_rather_than_producing_an_unreadable_file() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    let all: HashSet<String> = sample().into_iter().map(|entry| entry.name).collect();
    rewrite_zip(
        &input,
        &output,
        &ZipRewrite {
            drop: all,
            replace: HashMap::new(),
        },
    )
    .unwrap();
    assert!(read_zip_entries(&output).unwrap().is_empty());
}

#[test]
fn the_dos_timestamp_and_the_attribute_words_survive_the_copy() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    patch_zip_headers(&input, |entry| {
        set_u16(entry.file, entry.central_at + 12, 0x4a2b);
        set_u16(entry.file, entry.central_at + 14, 0x5d1c);
        set_u16(entry.file, entry.local_at + 10, 0x4a2b);
        set_u16(entry.file, entry.local_at + 12, 0x5d1c);
        set_u32(entry.file, entry.central_at + 38, 0x81a4_0000);
    });

    rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap();

    for entry in read_zip_entries(&output).unwrap() {
        assert_eq!(entry.mod_time, 0x4a2b, "{}", entry.name);
        assert_eq!(entry.mod_date, 0x5d1c, "{}", entry.name);
        assert_eq!(entry.external_attributes, 0x81a4_0000, "{}", entry.name);
    }
}

#[test]
fn an_entry_larger_than_one_copy_chunk_survives_the_copy_intact() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // Past the rewriter's 1 MiB copy buffer, and stored rather than deflated so the *compressed*
    // bytes are what crosses several chunks. A mutation that wrote the whole buffer instead of the
    // last partial slice is invisible on any entry that fits in one chunk.
    let big: Vec<u8> = (0..3 * (1usize << 20) + 777)
        .map(|i| (i.wrapping_mul(31) & 0xff) as u8)
        .collect();
    let mut entries = sample();
    entries.push(stored("Metadata/big.bin", &big));
    write_zip(&input, &entries, None);

    rewrite_zip(&input, &output, &dropping(&["Metadata/stored.txt"])).unwrap();

    let after = read_zip_entries(&output).unwrap();
    let entry = find(&after, "Metadata/big.bin");
    assert_eq!(entry.uncompressed_size, big.len() as u64);
    assert_eq!(read_zip_entry_bytes(&output, entry).unwrap(), big);
    assert_eq!(entry.crc, crc32(&big));
}

#[test]
fn a_size_that_genuinely_does_not_fit_a_non_zip64_record_is_refused() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    // The archive is a few hundred bytes; the *declaration* is what does not fit. `0xffffffff` is
    // itself unrepresentable, being the sentinel that sends a reader to a zip64 record this writer
    // does not emit, so it is the cheapest value that proves the branch.
    write_zip(
        &input,
        &sample(),
        Some(Zip64Options {
            saturate_entries: true,
            ..Zip64Options::default()
        }),
    );
    patch_zip_headers(&input, |entry| {
        if entry.name != "Metadata/stored.txt" {
            return;
        }
        let extra_at =
            entry.central_at + 46 + usize::from(get_u16(entry.file, entry.central_at + 28));
        set_u64(entry.file, extra_at + 4, 0xffff_ffff);
    });
    assert_eq!(
        find(&read_zip_entries(&input).unwrap(), "Metadata/stored.txt").uncompressed_size,
        0xffff_ffff
    );

    let error = rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap_err();
    assert_eq!(reason_of(&error), Some("unrepresentable"));
    assert!(!output.exists());
}

#[test]
fn an_entry_whose_sizes_really_do_live_in_a_data_descriptor_round_trips() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    let before = find(&read_zip_entries(&input).unwrap(), "3D/3dmodel.model").clone();
    // The genuine article, not just the flag: bit 3 set *and* the local header's CRC and both
    // sizes zeroed, which is what a streaming writer emits. A rewriter reading sizes from the
    // local header would pass the flag test and produce a zero-length entry here.
    patch_zip_headers(&input, |entry| {
        set_u16(entry.file, entry.central_at + 8, FLAG_DATA_DESCRIPTOR);
        set_u16(entry.file, entry.local_at + 6, FLAG_DATA_DESCRIPTOR);
        set_u32(entry.file, entry.local_at + 14, 0);
        set_u32(entry.file, entry.local_at + 18, 0);
        set_u32(entry.file, entry.local_at + 22, 0);
    });

    rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap();

    let entries = read_zip_entries(&output).unwrap();
    let after = find(&entries, "3D/3dmodel.model");
    assert_eq!(after.flags, 0);
    assert_eq!(after.crc, before.crc);
    assert_eq!(after.compressed_size, before.compressed_size);
    assert_eq!(after.uncompressed_size, before.uncompressed_size);
    assert_eq!(
        local_header_of(&output, after),
        LocalHeader {
            flags: 0,
            method: before.method,
            crc: before.crc,
            compressed_size: before.compressed_size as u32,
            uncompressed_size: before.uncompressed_size as u32,
        }
    );
    assert_eq!(
        String::from_utf8(read_zip_entry_bytes(&output, after).unwrap()).unwrap(),
        MODEL_XML
    );
}

#[test]
fn a_local_header_with_no_signature_is_refused_as_unreadable_and_leaves_nothing_behind() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    // The central directory still parses, so this is caught during the copy, after the output
    // file has been created: which is the branch that has to remove what it wrote.
    patch_zip_headers(&input, |entry| {
        if entry.name == "Metadata/stored.txt" {
            set_u32(entry.file, entry.local_at, 0x0bad_f00d);
        }
    });

    let error = rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap_err();
    assert_eq!(reason_of(&error), Some("unreadable"));
    assert!(!output.exists());
}

#[test]
fn an_entry_that_runs_off_the_end_of_the_file_is_refused_as_unreadable() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("in.3mf");
    let output = dir.path().join("out.3mf");
    write_zip(&input, &sample(), None);
    let beyond = (fs::metadata(&input).unwrap().len() + 4096) as u32;
    patch_zip_headers(&input, |entry| {
        if entry.name == "Metadata/stored.txt" {
            set_u32(entry.file, entry.central_at + 20, beyond);
        }
    });

    let error = rewrite_zip(&input, &output, &ZipRewrite::default()).unwrap_err();
    assert_eq!(reason_of(&error), Some("unreadable"));
    assert!(!output.exists());
}
