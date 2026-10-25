//! PNG: reading a size out of one, and writing the rasterizer's output as one.
//!
//! Hand-written against the PNG spec rather than pulled from a crate. The encoder emits exactly
//! the three chunks a truecolour image needs, with filter byte 0 on every scanline, which is what
//! the byte-exact layout test pins; a general-purpose encoder chooses its own filters and chunks.

use std::io::Write;
use std::sync::OnceLock;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use serde_json::{Map, Value};

use crate::error::{AppError, Result};

const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// Reads width and height from IHDR, which the format requires to be the first chunk.
pub fn read_png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((width, height))
}

/// The CRC-32 table of PNG spec Annex D.
fn crc_table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (n, slot) in table.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        table
    })
}

fn crc32(parts: &[&[u8]]) -> u32 {
    let table = crc_table();
    let mut c = 0xffff_ffffu32;
    for part in parts {
        for byte in *part {
            c = table[((c ^ u32::from(*byte)) & 0xff) as usize] ^ (c >> 8);
        }
    }
    c ^ 0xffff_ffff
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

/// Encodes 8-bit truecolour (no alpha, no interlace) RGB pixels as a PNG.
///
/// `rgb` is row-major, three bytes per pixel, no padding: exactly what the rasterizer produces.
/// Each scanline gets filter byte 0 (`None`): the rasterizer's output has no structure a PNG
/// filter would exploit, so paying deflate's cost without a filter's benefit is not worth the
/// extra code.
///
/// Deterministic for a fixed input and a fixed `flate2` build. The compressed bytes are a
/// deflate-implementation detail, not something this function controls; what is guaranteed is
/// what IDAT decompresses to (the filtered scanlines), which is what the layout test checks.
pub fn encode_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if width == 0 || height == 0 {
        let mut details = Map::new();
        details.insert("width".into(), Value::from(width));
        details.insert("height".into(), Value::from(height));
        return Err(
            AppError::validation("width and height must be positive integers")
                .with_details(details),
        );
    }
    let stride = width as usize * 3;
    if rgb.len() != stride * height as usize {
        let mut details = Map::new();
        details.insert("width".into(), Value::from(width));
        details.insert("height".into(), Value::from(height));
        details.insert("length".into(), Value::from(rgb.len() as u64));
        return Err(
            AppError::validation("rgb buffer length does not match width * height * 3")
                .with_details(details),
        );
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    for row in rgb.chunks_exact(stride) {
        encoder.write_all(&[0])?;
        encoder.write_all(row)?;
    }
    let idat = encoder.finish()?;

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    // bytes 10-12 (compression, filter, interlace methods) are zero.

    let mut out = Vec::with_capacity(SIGNATURE.len() + 12 * 3 + ihdr.len() + idat.len());
    out.extend_from_slice(&SIGNATURE);
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &idat);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}
