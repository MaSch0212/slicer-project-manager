//! Files the tests put on disk or upload: zips, PNGs and a binary STL, built at test time.

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// The smallest real zip that carries `entries`: every entry stored (uncompressed), a central
/// directory, and an end-of-central-directory record.
pub fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, data) in entries {
        let crc = crc32(data);
        let offset = body.len() as u32;
        let name = name.as_bytes();

        body.extend(0x0403_4b50u32.to_le_bytes());
        body.extend(20u16.to_le_bytes()); // version needed
        body.extend(0u16.to_le_bytes()); // flags
        body.extend(0u16.to_le_bytes()); // stored
        body.extend(0u32.to_le_bytes()); // time and date
        body.extend(crc.to_le_bytes());
        body.extend((data.len() as u32).to_le_bytes());
        body.extend((data.len() as u32).to_le_bytes());
        body.extend((name.len() as u16).to_le_bytes());
        body.extend(0u16.to_le_bytes()); // extra length
        body.extend(name);
        body.extend(*data);

        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes()); // made by
        central.extend(20u16.to_le_bytes()); // version needed
        central.extend(0u16.to_le_bytes()); // flags
        central.extend(0u16.to_le_bytes()); // stored
        central.extend(0u32.to_le_bytes()); // time and date
        central.extend(crc.to_le_bytes());
        central.extend((data.len() as u32).to_le_bytes());
        central.extend((data.len() as u32).to_le_bytes());
        central.extend((name.len() as u16).to_le_bytes());
        central.extend([0u8; 8]); // extra, comment, disk, internal attributes
        central.extend(0u32.to_le_bytes()); // external attributes
        central.extend(offset.to_le_bytes());
        central.extend(name);
    }
    let central_offset = body.len() as u32;
    let central_size = central.len() as u32;
    body.extend(central);
    body.extend(0x0605_4b50u32.to_le_bytes());
    body.extend([0u8; 4]); // disk numbers
    body.extend((entries.len() as u16).to_le_bytes());
    body.extend((entries.len() as u16).to_le_bytes());
    body.extend(central_size.to_le_bytes());
    body.extend(central_offset.to_le_bytes());
    body.extend(0u16.to_le_bytes()); // comment length
    body
}

/// A Cura project: the metadata that classifies a 3MF as `slicer_project`, with an embedded
/// thumbnail the preview queue can lift out.
pub fn cura_project(thumbnail: &[u8]) -> Vec<u8> {
    zip(&[
        ("[Content_Types].xml", b"<Types/>"),
        (
            "3D/3dmodel.model",
            br#"<?xml version="1.0"?><model unit="millimeter"><resources/></model>"#,
        ),
        ("Cura/plugin_metadata.json", b"{}"),
        ("Cura/preferences.cfg", b"[general]"),
        ("Metadata/thumbnail.png", thumbnail),
    ])
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend(kind);
    out.extend(data);
    let mut checked = kind.to_vec();
    checked.extend(data);
    out.extend(crc32(&checked).to_be_bytes());
    out
}

/// A minimal valid truecolour PNG of the given size.
pub fn png(width: u32, height: u32) -> Vec<u8> {
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    let raw = vec![0u8; (width as usize * 3 + 1) * height as usize];
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).unwrap();
    let idat = encoder.finish().unwrap();
    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
    out.extend(png_chunk(b"IHDR", &ihdr));
    out.extend(png_chunk(b"IDAT", &idat));
    out.extend(png_chunk(b"IEND", &[]));
    out
}

/// The width and height a PNG declares in its header.
pub fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], &[137, 80, 78, 71, 13, 10, 26, 10], "not a PNG");
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    (width, height)
}

/// A unit cube as a binary STL: 12 triangles.
pub fn cube_stl() -> Vec<u8> {
    const CORNERS: [[f32; 3]; 8] = [
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
    ];
    const FACES: [[usize; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [2, 3, 7],
        [2, 7, 6],
        [1, 2, 6],
        [1, 6, 5],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut out = vec![0u8; 80];
    out.extend((FACES.len() as u32).to_le_bytes());
    for face in FACES {
        out.extend([0u8; 12]); // normal, recomputed by the rasterizer
        for corner in face {
            for value in CORNERS[corner] {
                out.extend(value.to_le_bytes());
            }
        }
        out.extend([0u8; 2]);
    }
    out
}
