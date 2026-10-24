//! Ports `zip.test.ts`: the zip64 shapes, the chunked reader, and the refusals for corrupt and
//! hostile archives.

use std::fs;
use std::path::Path;

use spm_core::AppErrorCode;
use spm_core::dto::FileKind;
use spm_core::files::chunks::ChunkSource;
use spm_core::files::classify::{Classification, classify_3mf};
use spm_core::files::zip::{
    DEFAULT_ZIP_CHUNK_BYTES, ZipChunkOptions, ZipEntry, find_zip_entry, open_zip, read_zip_entries,
    read_zip_entry_bytes, read_zip_entry_chunks, read_zip_entry_text, reads_as_zip,
};
use tempfile::tempdir;

use crate::fixtures::{MODEL_XML, Zip64Options, deflated, get_u16, stored, write_zip};

fn assert_validation<T: std::fmt::Debug>(result: spm_core::Result<T>) -> spm_core::AppError {
    let error = result.expect_err("expected a Validation error");
    assert_eq!(error.code, AppErrorCode::Validation, "{error}");
    error
}

/// A payload that deflates well and is far larger than one inflater output chunk.
fn big_xml() -> String {
    let mut text = String::from(r#"<?xml version="1.0"?><model><resources><mesh><vertices>"#);
    for i in 0..60_000 {
        text.push_str(&format!(
            r#"<vertex x="{i}.5" y="{}.25" z="{}"/>"#,
            -i,
            (i % 97) as f64 / 8.0
        ));
    }
    text.push_str("</vertices></mesh></resources></model>");
    text
}

/// The three-entry archive every case below varies, written with the given zip64 shape.
fn write_sample(path: &Path, zip64: Option<Zip64Options>, payload: &str) {
    write_zip(
        path,
        &[
            stored("[Content_Types].xml", "<Types/>"),
            deflated("3D/3dmodel.model", payload),
            stored("Metadata/stored.txt", "stored verbatim, no deflate"),
        ],
        zip64,
    );
}

fn collect(entries: &[ZipEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|e| {
            format!(
                "{} m{} c{} u{}",
                e.name, e.method, e.compressed_size, e.uncompressed_size
            )
        })
        .collect()
}

#[derive(Debug)]
struct Drained {
    bytes: Vec<u8>,
    max_chunk: usize,
    count: usize,
}

fn drain(chunks: impl Iterator<Item = spm_core::Result<Vec<u8>>>) -> spm_core::Result<Drained> {
    let mut out = Drained {
        bytes: Vec::new(),
        max_chunk: 0,
        count: 0,
    };
    for chunk in chunks {
        let chunk = chunk?;
        out.max_chunk = out.max_chunk.max(chunk.len());
        out.count += 1;
        out.bytes.extend(chunk);
    }
    Ok(out)
}

/// Overwrites `length` bytes at `at`, or splices them out when `replacement` is empty.
fn patch_file(path: &Path, at: usize, length: usize, replacement: &[u8]) {
    let bytes = fs::read(path).unwrap();
    let mut out = bytes[..at].to_vec();
    out.extend_from_slice(replacement);
    out.extend_from_slice(&bytes[at + length..]);
    fs::write(path, out).unwrap();
}

fn find_signature(path: &Path, signature: u32) -> usize {
    let bytes = fs::read(path).unwrap();
    (0..=bytes.len() - 4)
        .rev()
        .find(|&i| bytes[i..i + 4] == signature.to_le_bytes())
        .unwrap_or_else(|| panic!("signature {signature:x} not found"))
}

const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const CD_SIG: u32 = 0x0201_4b50;

const REFERENCE_SHAPE: Zip64Options = Zip64Options {
    end: true,
    saturate_cd_offset: true,
    saturate_entries: true,
    saturate_cd_size: false,
    saturate_total: false,
    saturate_entry_offset_only: false,
};

// ---------------------------------------------------------------------------------------------
// zip64
// ---------------------------------------------------------------------------------------------

#[test]
fn a_zip64_archive_reads_exactly_like_the_same_archive_written_32_bit() {
    let dir = tempdir().unwrap();
    let plain = dir.path().join("plain.3mf");
    let zip64 = dir.path().join("zip64.3mf");
    write_sample(&plain, None, MODEL_XML);
    // The shape the 28 zip64 files in the reference library have: a saturated directory offset
    // and saturated per-entry sizes, beside a real 16-bit entry count and 32-bit directory size.
    write_sample(&zip64, Some(REFERENCE_SHAPE), MODEL_XML);

    assert_eq!(
        collect(&read_zip_entries(&zip64).unwrap()),
        collect(&read_zip_entries(&plain).unwrap())
    );
    let entries = read_zip_entries(&zip64).unwrap();
    let model = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    assert_eq!(read_zip_entry_text(&zip64, model).unwrap(), MODEL_XML);
    let stored = find_zip_entry(&entries, "Metadata/stored.txt").unwrap();
    assert_eq!(
        read_zip_entry_text(&zip64, stored).unwrap(),
        "stored verbatim, no deflate"
    );
}

#[test]
fn a_zip64_3mf_classifies_as_the_model_it_is_not_as_other() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, Some(REFERENCE_SHAPE), MODEL_XML);
    // Before zip64 support these real files were rejected by the reader, and the classifier's
    // catch-all turned every one of them into kind `other`: invisible to the preview queue.
    assert_eq!(
        classify_3mf(&path),
        Classification {
            kind: FileKind::Model,
            slicer: None,
            unreadable: false
        }
    );
}

#[test]
fn a_saturated_entry_count_and_directory_size_are_taken_from_the_zip64_record() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(
        &path,
        Some(Zip64Options {
            end: true,
            saturate_total: true,
            saturate_cd_size: true,
            saturate_cd_offset: true,
            saturate_entries: true,
            saturate_entry_offset_only: false,
        }),
        MODEL_XML,
    );
    assert_eq!(read_zip_entries(&path).unwrap().len(), 3);
}

#[test]
fn the_zip64_record_is_ignored_where_the_base_record_is_not_saturated() {
    let dir = tempdir().unwrap();
    let plain = dir.path().join("plain.3mf");
    let path = dir.path().join("redundant.3mf");
    write_sample(&plain, None, MODEL_XML);
    // A zip64 end record and locator, but every base field small enough to be honest, and then
    // the record poisoned, so a reader that consults it unconditionally cannot get this right.
    write_sample(
        &path,
        Some(Zip64Options {
            end: true,
            ..Zip64Options::default()
        }),
        MODEL_XML,
    );
    let record = find_signature(&path, ZIP64_EOCD_SIG);
    let mut poison = [0u8; 24];
    poison[0..8].copy_from_slice(&999u64.to_le_bytes()); // entry count
    poison[8..16].copy_from_slice(&7u64.to_le_bytes()); // directory size
    poison[16..24].copy_from_slice(&4u64.to_le_bytes()); // directory offset
    patch_file(&path, record + 32, 24, &poison);

    assert_eq!(
        collect(&read_zip_entries(&path).unwrap()),
        collect(&read_zip_entries(&plain).unwrap())
    );
}

#[test]
fn entering_the_zip64_record_does_not_make_its_unsaturated_fields_authoritative() {
    let dir = tempdir().unwrap();
    let plain = dir.path().join("plain.3mf");
    let path = dir.path().join("partial.3mf");
    write_sample(&plain, None, MODEL_XML);
    // Only the directory offset is saturated, so only the offset may be taken from the record,
    // even though the reader is now inside the zip64 branch and has the other two in its hand.
    write_sample(&path, Some(REFERENCE_SHAPE), MODEL_XML);
    let record = find_signature(&path, ZIP64_EOCD_SIG);
    let mut poison = [0u8; 16];
    poison[0..8].copy_from_slice(&999u64.to_le_bytes()); // entry count
    poison[8..16].copy_from_slice(&7u64.to_le_bytes()); // directory size
    patch_file(&path, record + 32, 16, &poison);

    assert_eq!(
        collect(&read_zip_entries(&path).unwrap()),
        collect(&read_zip_entries(&plain).unwrap())
    );
}

#[test]
fn a_zip64_locator_whose_signature_is_wrong_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, Some(REFERENCE_SHAPE), MODEL_XML);
    let locator = find_signature(&path, ZIP64_LOCATOR_SIG);
    // Everything else about the archive stays valid, so only the signature check can catch this;
    // the 8 bytes at locator+8 still hold the record's true offset.
    patch_file(&path, locator, 4, &[0x50, 0x4b, 0x09, 0x09]);
    assert_validation(read_zip_entries(&path));
}

#[test]
fn a_zip64_extra_field_is_read_positionally_against_the_base_record_not_from_the_front() {
    let dir = tempdir().unwrap();
    let plain = dir.path().join("plain.3mf");
    let path = dir.path().join("offset-only.3mf");
    write_sample(&plain, None, MODEL_XML);
    // Only the local header offset is saturated, so the extra field's single 64-bit word is the
    // offset. A reader that takes words in fixed order without checking the base record reads it
    // as the uncompressed size and then reads the sizes as garbage.
    write_sample(
        &path,
        Some(Zip64Options {
            end: true,
            saturate_entry_offset_only: true,
            ..Zip64Options::default()
        }),
        MODEL_XML,
    );
    assert_eq!(
        collect(&read_zip_entries(&path).unwrap()),
        collect(&read_zip_entries(&plain).unwrap())
    );
    let entries = read_zip_entries(&path).unwrap();
    let model = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    assert_eq!(read_zip_entry_text(&path, model).unwrap(), MODEL_XML);
}

#[test]
fn a_zip64_archive_whose_locator_has_been_spliced_out_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, Some(REFERENCE_SHAPE), MODEL_XML);
    let locator = find_signature(&path, ZIP64_LOCATOR_SIG);
    patch_file(&path, locator, 20, &[]);
    assert_validation(read_zip_entries(&path));
}

#[test]
fn a_zip64_locator_pointing_past_the_end_of_the_file_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, Some(REFERENCE_SHAPE), MODEL_XML);
    let locator = find_signature(&path, ZIP64_LOCATOR_SIG);
    patch_file(&path, locator + 8, 8, &(1u64 << 40).to_le_bytes());
    assert_validation(read_zip_entries(&path));
}

#[test]
fn a_zip64_record_with_the_wrong_signature_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, Some(REFERENCE_SHAPE), MODEL_XML);
    let record = find_signature(&path, ZIP64_EOCD_SIG);
    patch_file(&path, record, 4, &[0, 0, 0, 0]);
    assert_validation(read_zip_entries(&path));
}

#[test]
fn a_zip64_size_past_the_safe_integer_range_is_a_validation_error_not_a_rounded_offset() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    // One stored entry, so the only central-directory signature in the file is the header's own.
    write_zip(&path, &[stored("a.txt", "hello")], Some(REFERENCE_SHAPE));
    let at = find_signature(&path, CD_SIG);
    let bytes = fs::read(&path).unwrap();
    let name_length = usize::from(get_u16(&bytes, at + 28));
    // The extra field's first word is the uncompressed size, because that is the first field the
    // base record saturated.
    patch_file(
        &path,
        at + 46 + name_length + 4,
        8,
        &((1u64 << 62) + 1).to_le_bytes(),
    );
    assert_validation(read_zip_entries(&path));
}

#[test]
fn an_entry_that_says_zip64_but_carries_no_extra_field_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    // `saturate_entries` would write the sentinels with their extra field; the lie here is the
    // sentinel without one.
    write_zip(
        &path,
        &[stored("a.txt", "hello")],
        Some(Zip64Options {
            end: true,
            saturate_cd_offset: true,
            ..Zip64Options::default()
        }),
    );
    let cd = find_signature(&path, CD_SIG);
    // Local header offset = 0xffffffff, and no extra field.
    patch_file(&path, cd + 42, 4, &[0xff; 4]);
    assert_validation(read_zip_entries(&path));
}

#[test]
fn a_truncated_central_directory_is_a_validation_error_rather_than_a_panic() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(
        &path,
        Some(Zip64Options {
            end: true,
            saturate_cd_offset: true,
            saturate_cd_size: true,
            saturate_entries: true,
            ..Zip64Options::default()
        }),
        MODEL_XML,
    );
    let record = find_signature(&path, ZIP64_EOCD_SIG);
    // Directory size, far too small.
    patch_file(&path, record + 40, 8, &12u64.to_le_bytes());
    assert_validation(read_zip_entries(&path));
}

// ---------------------------------------------------------------------------------------------
// the chunked reader
// ---------------------------------------------------------------------------------------------

fn options(max: usize) -> ZipChunkOptions {
    ZipChunkOptions {
        max_chunk_bytes: Some(max),
    }
}

#[test]
fn the_chunked_reader_yields_exactly_the_bytes_the_buffered_reader_returns() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("big.3mf");
    write_sample(&path, None, &big_xml());
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let buffered = read_zip_entry_bytes(&path, entry).unwrap();
    let streamed =
        drain(read_zip_entry_chunks(&path, entry, ZipChunkOptions::default()).unwrap()).unwrap();
    assert!(
        streamed.count > 1,
        "the payload must span more than one chunk to test anything"
    );
    assert_eq!(streamed.bytes, buffered);
}

#[test]
fn no_chunk_exceeds_the_requested_bound_and_the_bound_can_be_tiny() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("big.3mf");
    let payload = big_xml();
    write_sample(&path, None, &payload);
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let streamed = drain(read_zip_entry_chunks(&path, entry, options(1000)).unwrap()).unwrap();
    assert!(
        streamed.max_chunk <= 1000,
        "largest chunk was {}",
        streamed.max_chunk
    );
    assert_eq!(String::from_utf8(streamed.bytes).unwrap(), payload);
    const { assert!(DEFAULT_ZIP_CHUNK_BYTES > 1000) };
}

#[test]
fn a_stored_entry_streams_too_without_an_inflater() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, MODEL_XML);
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "Metadata/stored.txt").unwrap();
    assert_eq!(entry.method, 0);
    let streamed = drain(read_zip_entry_chunks(&path, entry, options(7)).unwrap()).unwrap();
    assert!(streamed.max_chunk <= 7);
    assert_eq!(
        String::from_utf8(streamed.bytes).unwrap(),
        "stored verbatim, no deflate"
    );
}

#[test]
fn a_zip64_entry_streams_the_same_bytes_as_it_reads() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    let payload = big_xml();
    write_sample(&path, Some(REFERENCE_SHAPE), &payload);
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let streamed = drain(read_zip_entry_chunks(&path, entry, options(8192)).unwrap()).unwrap();
    assert_eq!(String::from_utf8(streamed.bytes).unwrap(), payload);
}

#[test]
fn open_zip_streams_from_the_descriptor_it_already_holds() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("big.3mf");
    write_sample(&path, None, &big_xml());
    let zip = open_zip(&path).unwrap();
    let entry = find_zip_entry(zip.entries(), "3D/3dmodel.model").unwrap();
    let streamed = drain(zip.read_chunks(entry, options(4096)).unwrap()).unwrap();
    assert_eq!(streamed.bytes, zip.read(entry).unwrap());
}

/// Legacy: pulling a deflated chunked read after `close()` had to fail instead of reading another
/// file, even when the descriptor number had been reused. Rust has no `close()` to call out of
/// order: a stream shares ownership of the archive's file, so the descriptor stays open for as
/// long as anything can read it and is never recycled underneath a reader. What has to hold is
/// that a deflated stream pulled after its `OpenZip` is dropped, with a decoy file open, still
/// yields exactly its own entry.
#[test]
fn a_deflated_chunked_read_outlives_its_zip_and_never_reads_another_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    let payload = big_xml();
    write_sample(&path, None, &payload);
    let decoy = dir.path().join("decoy.bin");
    fs::write(&decoy, vec![0x44u8; 2 * 1024 * 1024]).unwrap();

    let zip = open_zip(&path).unwrap();
    let entry = find_zip_entry(zip.entries(), "3D/3dmodel.model").unwrap();
    let mut chunks = zip.read_chunks(entry, options(4096)).unwrap();
    let mut bytes = chunks.pull_chunk().unwrap().unwrap().to_vec();
    drop(zip);
    let _decoy = fs::File::open(&decoy).unwrap();
    while let Some(chunk) = chunks.pull_chunk().unwrap() {
        bytes.extend_from_slice(chunk);
    }
    assert_eq!(String::from_utf8(bytes).unwrap(), payload);
}

/// The stored twin of the test above: the dangerous one, because a stored entry is read straight
/// from the file with no inflater to notice that the bytes are nonsense.
#[test]
fn a_stored_chunked_read_outlives_its_zip_and_never_reads_another_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    let payload = "x".repeat(200_000);
    write_zip(
        &path,
        &[
            stored("Metadata/stored.txt", &payload),
            deflated("3D/3dmodel.model", MODEL_XML),
        ],
        None,
    );
    let decoy = dir.path().join("decoy.bin");
    fs::write(&decoy, vec![0x44u8; 2 * 1024 * 1024]).unwrap();

    let zip = open_zip(&path).unwrap();
    let entry = find_zip_entry(zip.entries(), "Metadata/stored.txt").unwrap();
    let mut chunks = zip.read_chunks(entry, options(4096)).unwrap();
    let mut bytes = chunks.pull_chunk().unwrap().unwrap().to_vec();
    drop(zip);
    let _decoy = fs::File::open(&decoy).unwrap();
    while let Some(chunk) = chunks.pull_chunk().unwrap() {
        bytes.extend_from_slice(chunk);
    }
    assert_eq!(String::from_utf8(bytes).unwrap(), payload);
}

#[test]
fn an_entry_that_does_not_inflate_to_its_declared_size_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, MODEL_XML);
    let entries = read_zip_entries(&path).unwrap();
    let model = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let stored = find_zip_entry(&entries, "Metadata/stored.txt").unwrap();
    // An importer charges the quota against `uncompressed_size` before writing the bytes this
    // returns, so a declaration that does not match what comes out is a quota bypass, not a
    // cosmetic inconsistency.
    for liar in [model, stored] {
        let liar = ZipEntry {
            uncompressed_size: 3,
            ..liar.clone()
        };
        assert_validation(read_zip_entry_bytes(&path, &liar));
        assert_validation(
            read_zip_entry_chunks(&path, &liar, ZipChunkOptions::default()).and_then(drain),
        );
    }
}

/// A deflated entry that declares a few bytes and inflates to far more is refused as soon as it is
/// seen to overrun, having produced one chunk rather than the whole output (the bound the legacy
/// streamed reader only enforced at the end).
#[test]
fn a_zip_bomb_declaring_a_few_bytes_is_refused_after_one_chunk_over_the_declaration() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bomb.3mf");
    write_zip(
        &path,
        &[deflated("bomb.bin", vec![0u8; 8 * 1024 * 1024])],
        None,
    );
    let entries = read_zip_entries(&path).unwrap();
    let liar = ZipEntry {
        uncompressed_size: 3,
        ..entries[0].clone()
    };
    let mut chunks = read_zip_entry_chunks(&path, &liar, options(1 << 16)).unwrap();
    let error = assert_validation(chunks.pull_chunk().map(|chunk| chunk.map(<[u8]>::len)));
    assert!(error.message.contains("declared"), "{error}");
}

#[test]
fn abandoning_a_chunked_read_part_way_closes_the_descriptor() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("big.3mf");
    write_sample(&path, None, &big_xml());
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();

    let mut seen = 0;
    {
        let mut chunks = read_zip_entry_chunks(&path, entry, options(4096)).unwrap();
        while let Some(chunk) = chunks.pull_chunk().unwrap() {
            seen += chunk.len();
            if seen > 8192 {
                break;
            }
        }
    }
    assert!(seen > 0);
    assert_no_handle_open(&path);
    fs::remove_file(&path).unwrap();
}

/// Fails when any handle on `path` is still open. Unlinking would not tell: files are opened with
/// delete sharing, so a leaked handle does not block it.
fn assert_no_handle_open(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Share mode 0 is refused while any other handle on the file is open.
        let exclusive = fs::OpenOptions::new().read(true).share_mode(0).open(path);
        assert!(
            exclusive.is_ok(),
            "the abandoned stream left a handle open: {:?}",
            exclusive.err()
        );
    }
    #[cfg(target_os = "linux")]
    {
        let target = fs::canonicalize(path).unwrap();
        for fd in fs::read_dir("/proc/self/fd").unwrap().flatten() {
            if let Ok(link) = fs::read_link(fd.path()) {
                assert_ne!(link, target, "the abandoned stream left a descriptor open");
            }
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = path;
}

#[test]
fn corrupt_deflate_data_fails_the_chunked_read_as_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, &big_xml());
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    // Wreck the middle of the compressed stream: the local header (30 bytes plus the name) is
    // intact, so the failure lands in the inflater rather than in the offset arithmetic.
    let at = entry.local_header_offset as usize + 30 + "3D/3dmodel.model".len() + 64;
    patch_file(&path, at, 32, &[0x5a; 32]);
    assert_validation(
        read_zip_entry_chunks(&path, entry, ZipChunkOptions::default()).and_then(drain),
    );
}

#[test]
fn corrupt_deflate_data_fails_the_buffered_read_as_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, &big_xml());
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let at = entry.local_header_offset as usize + 30 + "3D/3dmodel.model".len() + 64;
    patch_file(&path, at, 32, &[0x5a; 32]);
    assert_validation(read_zip_entry_bytes(&path, entry));
}

#[test]
fn an_unsupported_compression_method_is_a_validation_error_on_both_paths() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, MODEL_XML);
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let bzip2 = ZipEntry {
        method: 12,
        ..entry.clone()
    };
    assert_validation(read_zip_entry_bytes(&path, &bzip2));
    assert_validation(
        read_zip_entry_chunks(&path, &bzip2, ZipChunkOptions::default()).and_then(drain),
    );
}

/// Legacy: an inflated entry comes back as a plain `Uint8Array`, not a node `Buffer`. The trap
/// does not exist in Rust, where an entry is an owned `Vec<u8>` whatever produced it; what is worth
/// asserting is the nearest thing: the buffered read hands back an owned copy, independent of the
/// reader.
#[test]
fn an_inflated_entry_comes_back_as_an_owned_buffer_independent_of_the_reader() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, MODEL_XML);
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    let mut bytes = read_zip_entry_bytes(&path, entry).unwrap();
    bytes[0] = 0x21;
    let again = read_zip_entry_bytes(&path, entry).unwrap();
    assert_ne!(again[0], 0x21);
    assert_eq!(again, MODEL_XML.as_bytes());
}

#[test]
fn an_entry_whose_declared_length_is_impossible_is_a_validation_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("z.3mf");
    write_sample(&path, None, MODEL_XML);
    let entries = read_zip_entries(&path).unwrap();
    let entry = find_zip_entry(&entries, "3D/3dmodel.model").unwrap();
    // A central directory can lie. A bad length has to be answered with a Validation error before
    // anything is allocated for it, not with an allocation failure.
    assert_validation(read_zip_entry_bytes(
        &path,
        &ZipEntry {
            compressed_size: 1 << 52,
            ..entry.clone()
        },
    ));
    assert_validation(read_zip_entry_chunks(
        &path,
        &ZipEntry {
            compressed_size: 1 << 52,
            ..entry.clone()
        },
        ZipChunkOptions::default(),
    ));

    // An offset no file can hold has to be rejected *as an offset*, and the message is the only
    // way to see which check fired. (The legacy case was a negative offset, which an unsigned
    // field cannot spell; the same guard catches a value past the safe-integer range.)
    let error = assert_validation(read_zip_entry_bytes(
        &path,
        &ZipEntry {
            local_header_offset: u64::MAX,
            ..entry.clone()
        },
    ));
    assert!(error.message.contains("impossible offset"), "{error}");
}

/// The predicate the desktop settle window rests on, driven here rather than only by consequence.
///
/// It exists to tell "a `.3mf` mid-write" from "a file that was never a ZIP", which `entry_hash`
/// cannot: that falls back to a plain SHA-256 when the directory does not parse, which is right
/// for an `.stl` and produces a plausible hash of half a file for the other. Every row below is a
/// case the caller actually meets, and the `true` row is what stops the whole thing being
/// satisfied by a predicate that refuses everything.
#[test]
fn reads_as_zip_answers_about_the_central_directory_and_only_about_that() {
    let dir = tempdir().unwrap();
    let good = dir.path().join("good.3mf");
    write_sample(&good, None, MODEL_XML);
    assert!(reads_as_zip(&good));

    // The whole point: a real archive truncated mid-write. The local header is there and the
    // central directory is not, which is exactly what a slicer's save looks like halfway through.
    let half = dir.path().join("half.3mf");
    fs::write(&half, &fs::read(&good).unwrap()[..40]).unwrap();
    assert!(!reads_as_zip(&half));

    // Not a ZIP at all, and not a failure either: the caller asks this only of files whose first
    // bytes claim to be one.
    let mesh = dir.path().join("cube.stl");
    fs::write(&mesh, "solid cube\nendsolid cube\n").unwrap();
    assert!(!reads_as_zip(&mesh));

    // Empty, and absent. Every reason this can be false is a reason for the caller to wait.
    let empty = dir.path().join("empty.3mf");
    fs::write(&empty, []).unwrap();
    assert!(!reads_as_zip(&empty));
    assert!(!reads_as_zip(&dir.path().join("nothing-here.3mf")));
}

/// The reason the chunked reader exists: a model part that inflates to hundreds of megabytes (the
/// reference library's largest is 674 MB) must never be one allocation, whatever its compression
/// ratio. 96 MiB of zeroes deflates about 1000:1; it has to arrive in bounded chunks, in full, from
/// a reader whose own buffer is the chunk bound.
#[test]
fn a_highly_compressible_entry_streams_in_bounded_chunks_whatever_its_ratio() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("zeroes.3mf");
    const TOTAL: usize = 96 * 1024 * 1024;
    write_zip(
        &path,
        &[deflated("3D/3dmodel.model", vec![0u8; TOTAL])],
        None,
    );
    let entries = read_zip_entries(&path).unwrap();
    let entry = &entries[0];
    assert!(
        entry.compressed_size * 500 < TOTAL as u64,
        "the fixture must be highly compressible"
    );

    let mut chunks = read_zip_entry_chunks(&path, entry, options(256 * 1024)).unwrap();
    let (mut total, mut largest) = (0usize, 0usize);
    while let Some(chunk) = chunks.pull_chunk().unwrap() {
        assert!(chunk.iter().all(|&byte| byte == 0));
        total += chunk.len();
        largest = largest.max(chunk.len());
    }
    assert_eq!(total, TOTAL);
    assert!(largest <= 256 * 1024);
}
