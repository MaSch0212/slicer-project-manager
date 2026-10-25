//! Ported from the legacy `png.test.ts`: the PNG encoder, and `read_png_size` reading it back.
//!
//! The legacy suite also rejected negative and fractional dimensions. `encode_png` takes `u32`s,
//! so neither can be passed; the dimension guard that remains is the zero one, and the "negative
//! dimensions whose product matches the buffer" trap (`-2 * -2 * 3 = 12`) cannot be constructed.

use std::io::Read;

use flate2::read::ZlibDecoder;
use spm_core::AppErrorCode;
use spm_core::files::zip_write::crc32;
use spm_core::previews::png::{encode_png, read_png_size};

use crate::common::code_of;

const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// width*height*3 bytes, three distinct colours so a real image round-trips meaningfully.
fn sample_rgb(width: usize, height: usize) -> Vec<u8> {
    let mut rgb = vec![0u8; width * height * 3];
    for i in 0..width * height {
        rgb[i * 3] = ((i * 37) & 0xff) as u8;
        rgb[i * 3 + 1] = ((i * 53) & 0xff) as u8;
        rgb[i * 3 + 2] = ((i * 91) & 0xff) as u8;
    }
    rgb
}

#[test]
fn encode_png_output_is_readable_by_read_png_size() {
    let png = encode_png(&sample_rgb(5, 3), 5, 3).unwrap();
    assert_eq!(read_png_size(&png), Some((5, 3)));
}

#[test]
fn encode_png_chunk_layout_is_byte_exact_for_a_2x2_fixture_derived_from_the_spec() {
    let rgb = sample_rgb(2, 2);
    let png = encode_png(&rgb, 2, 2).unwrap();

    // Signature: the eight fixed bytes the PNG spec (5.2) mandates.
    assert_eq!(png[..8], SIGNATURE);

    // IHDR is fully determined by width/height for this encoding (8-bit truecolour, no
    // interlace), so its whole 25-byte chunk (length + type + 13 data bytes + crc) is built by
    // hand here rather than trusting whatever the encoder happened to emit.
    let mut ihdr_data = [0u8; 13];
    ihdr_data[0..4].copy_from_slice(&2u32.to_be_bytes()); // width
    ihdr_data[4..8].copy_from_slice(&2u32.to_be_bytes()); // height
    ihdr_data[8] = 8; // bit depth
    ihdr_data[9] = 2; // colour type: truecolour
    // compression, filter, interlace methods: 0
    let mut expected_ihdr = Vec::new();
    expected_ihdr.extend(13u32.to_be_bytes());
    expected_ihdr.extend(b"IHDR");
    expected_ihdr.extend(ihdr_data);
    expected_ihdr.extend(crc32(&[b"IHDR".as_slice(), &ihdr_data].concat()).to_be_bytes());
    assert_eq!(png[8..33], expected_ihdr[..]);

    // IEND is always these exact 12 bytes: zero-length data, fixed type, and a CRC over just the
    // type bytes.
    let mut expected_iend = Vec::new();
    expected_iend.extend(0u32.to_be_bytes());
    expected_iend.extend(b"IEND");
    expected_iend.extend(crc32(b"IEND").to_be_bytes());
    assert_eq!(png[png.len() - 12..], expected_iend[..]);

    // A literal golden, independent of any CRC implementation: the PNG spec (5.6, and the worked
    // example in Annex D) publishes IEND's encoding as exactly these 12 bytes, since its data is
    // always empty and its type is always "IEND". Pasted from the spec, not computed.
    let spec_iend = [
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    assert_eq!(png[png.len() - 12..], spec_iend);

    // Everything between IHDR and IEND is exactly one IDAT chunk: length + 'IDAT' + data + crc.
    let idat_length = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
    assert_eq!(png.len(), 33 + 12 + idat_length + 12);
    assert_eq!(&png[37..41], b"IDAT");
    let idat_data = &png[41..41 + idat_length];
    let idat_crc = u32::from_be_bytes(png[41 + idat_length..45 + idat_length].try_into().unwrap());
    assert_eq!(idat_crc, crc32(&[b"IDAT".as_slice(), idat_data].concat()));

    // The compressed payload is opaque (deflate's exact bytes are implementation-defined), but
    // what it decompresses to is spec-mandated: filter byte 0 then the raw RGB bytes, per row.
    let stride = 2 * 3;
    let mut expected_raw = Vec::new();
    for row in rgb.chunks(stride) {
        expected_raw.push(0);
        expected_raw.extend(row);
    }
    let mut inflated = Vec::new();
    ZlibDecoder::new(idat_data)
        .read_to_end(&mut inflated)
        .unwrap();
    assert_eq!(inflated, expected_raw);
}

#[test]
fn encode_png_rejects_an_rgb_buffer_of_the_wrong_length() {
    assert_eq!(
        code_of(encode_png(&[0u8; 10], 2, 2)),
        AppErrorCode::Validation
    );
}

#[test]
fn encode_png_rejects_a_zero_dimension() {
    assert_eq!(code_of(encode_png(&[], 0, 5)), AppErrorCode::Validation);
    assert_eq!(code_of(encode_png(&[], 5, 0)), AppErrorCode::Validation);
}

#[test]
fn encode_png_is_deterministic_across_runs_in_the_same_process() {
    let rgb = sample_rgb(9, 7);
    assert_eq!(
        encode_png(&rgb, 9, 7).unwrap(),
        encode_png(&rgb, 9, 7).unwrap()
    );
}
