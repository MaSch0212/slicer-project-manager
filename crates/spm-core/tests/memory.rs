//! The README's "Preview memory" guarantee, measured rather than assumed.
//!
//! > Nothing is read whole: a 164 MB STL and a 3MF whose model part inflates to 674 MB both pass
//! > through a fixed 256 KB window, so what is left in the peak is the mesh itself, at 36 bytes
//! > per triangle plus 12 per distinct vertex.
//!
//! This is its own test binary because it installs a counting global allocator
//! (`peak_alloc::PeakAlloc`, a dev-dependency: the workspace forbids `unsafe`, which an allocator
//! needs, so the wrapper is a crate's rather than this file's). The allocator counts every thread
//! in the process, so everything runs in **one** `#[test]` and the scenarios run one after
//! another; a second test in this binary would measure the first.
//!
//! Each scenario writes a large synthetic file by *streaming* it to disk (the generator holds a
//! few kilobytes, never the document), parses it, and compares the allocator's peak above the
//! baseline against `mesh_bytes_for(vertices, triangles)`, the formula the README states. The
//! assertion is that the peak is the mesh plus a small constant, and that the constant is far
//! below the size of the input: a parser that held its input would fail the second half.
//!
//! `SPM_MEMORY_TEST_SCALE=<n>` multiplies every fixture's size (default 1, about 60 MB each). At 10
//! the files are the README's reference sizes (a ~590 MB inflated model part, a ~570 MB STL);
//! the default keeps `pnpm verify` quick. The mesh ceiling is lifted for the test, since what is
//! measured is memory, not the ceiling.
//!
//! The figures each scenario measured are printed (`cargo test -p spm-core --test memory --
//! --nocapture`).

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use flate2::Compression;
use flate2::write::DeflateEncoder;
use peak_alloc::PeakAlloc;
use spm_core::dto::FileKind;
use spm_core::files::zip_write::{
    ZipCentralFields, ZipCommonFields, central_header_bytes, end_of_central_directory_bytes,
    local_header_bytes,
};
use spm_core::previews::mesh::limits::mesh_bytes_for;
use spm_core::previews::mesh::obj::parse_obj_file;
use spm_core::previews::mesh::stl::parse_stl_file;
use spm_core::previews::mesh::threemf::{ScanProbe, WINDOW_BYTES, parse_3mf_mesh_probed};
use spm_core::previews::{MeshHandler, MeshLimits, PreviewHandler, PreviewJob};
use tempfile::tempdir;

#[global_allocator]
static ALLOCATOR: PeakAlloc = PeakAlloc;

const MIB: usize = 1024 * 1024;

/// What the parse may add beyond the mesh: the 256 KB window, one 64 KB zip chunk, the inflater's
/// tables, a 32 KB read buffer, and the file-reader chunk. Measured at a fraction of this; the
/// slack exists so the test states a bound, not a coincidence.
const FIXED_OVERHEAD: usize = 2 * MIB;

/// Peak allocation above the baseline while `work` runs, and what it returned.
fn peak_above_baseline<T>(work: impl FnOnce() -> T) -> (usize, T) {
    let baseline = ALLOCATOR.current_usage();
    ALLOCATOR.reset_peak_usage();
    let result = work();
    (ALLOCATOR.peak_usage().saturating_sub(baseline), result)
}

fn mib(bytes: usize) -> f64 {
    bytes as f64 / MIB as f64
}

// --- streaming generators -----------------------------------------------------------------

/// Buffers writes and flushes them in 64 KB pieces, so a generator never holds more than that.
struct Chunked<W: Write> {
    inner: W,
    pending: Vec<u8>,
    total: u64,
}

impl<W: Write> Chunked<W> {
    fn new(inner: W) -> Self {
        Chunked {
            inner,
            pending: Vec::with_capacity(64 * 1024),
            total: 0,
        }
    }

    fn put(&mut self, text: &str) {
        self.put_bytes(text.as_bytes());
    }

    fn put_bytes(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        self.total += bytes.len() as u64;
        if self.pending.len() >= 64 * 1024 {
            self.flush_pending();
        }
    }

    fn flush_pending(&mut self) {
        self.inner.write_all(&self.pending).unwrap();
        self.pending.clear();
    }

    fn finish(mut self) -> (W, u64) {
        self.flush_pending();
        (self.inner, self.total)
    }
}

/// Counts what passes through, so the compressed size is known without holding it.
struct Counting<W: Write> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(bytes)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// A one-entry deflated 3MF whose model part is streamed in by `generate`. Returns the inflated
/// size of the model part.
///
/// The entry's CRC is written as 0: the reader checks the declared *sizes*, not the checksum, and
/// computing one incrementally would need a dependency this file does not otherwise have.
fn write_streamed_3mf(path: &Path, generate: impl FnOnce(&mut Chunked<&mut dyn Write>)) -> u64 {
    const NAME: &[u8] = b"3D/3dmodel.model";
    let common = |compressed: u32, uncompressed: u32| ZipCommonFields {
        version_needed: 20,
        flags: 0,
        method: 8,
        mod_time: 0,
        mod_date: 0,
        crc: 0,
        compressed_size: compressed,
        uncompressed_size: uncompressed,
        name: NAME.to_vec(),
        extra: Vec::new(),
    };

    let mut file = BufWriter::new(File::create(path).unwrap());
    let local = local_header_bytes(&common(0, 0));
    file.write_all(&local).unwrap();

    let encoder = DeflateEncoder::new(
        Counting {
            inner: &mut file,
            written: 0,
        },
        Compression::fast(),
    );
    let mut encoder = encoder;
    let uncompressed = {
        let mut sink = Chunked::new(&mut encoder as &mut dyn Write);
        generate(&mut sink);
        sink.finish().1
    };
    let compressed = encoder.finish().unwrap().written;
    let central_offset = local.len() as u64 + compressed;

    let central = central_header_bytes(&ZipCentralFields {
        common: common(compressed as u32, uncompressed as u32),
        version_made_by: 20,
        internal_attributes: 0,
        external_attributes: 0,
        local_header_offset: 0,
    });
    file.write_all(&central).unwrap();
    file.write_all(&end_of_central_directory_bytes(
        1,
        central.len() as u32,
        central_offset as u32,
    ))
    .unwrap();
    // Now the sizes are known: rewrite the local header, which has the same length.
    file.seek(SeekFrom::Start(0)).unwrap();
    file.write_all(&local_header_bytes(&common(
        compressed as u32,
        uncompressed as u32,
    )))
    .unwrap();
    file.flush().unwrap();
    uncompressed
}

/// `n` vertices and `n` triangles, optionally preceded by `comment_bytes` of XML comment, in the
/// shape of a real slicer export.
fn generate_grid_model(sink: &mut Chunked<&mut dyn Write>, n: usize, comment_bytes: usize) {
    sink.put(r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources>"#);
    sink.put(r#"<object id="1" type="model"><mesh><vertices>"#);
    if comment_bytes > 0 {
        sink.put("<!-- ");
        let filler = "x".repeat(4096);
        for _ in 0..comment_bytes / filler.len() {
            sink.put(&filler);
        }
        sink.put(" -->");
    }
    let mut tag = String::new();
    for i in 0..n {
        tag.clear();
        // A 1000-wide grid of points: compact enough that the whole job can be rasterized.
        tag.push_str(&format!(
            r#"<vertex x="{}" y="{}" z="{}"/>"#,
            i % 1000,
            (i / 1000) % 1000,
            (i / 1_000_000) % 10
        ));
        sink.put(&tag);
    }
    sink.put("</vertices><triangles>");
    for i in 0..n {
        tag.clear();
        tag.push_str(&format!(
            r#"<triangle v1="{}" v2="{}" v3="{}"/>"#,
            i % n,
            (i + 1) % n,
            (i + 1000) % n
        ));
        sink.put(&tag);
    }
    sink.put(
        r#"</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#,
    );
}

fn write_binary_stl(path: &Path, triangles: usize) {
    let mut sink = Chunked::new(BufWriter::new(File::create(path).unwrap()));
    let mut header = [0u8; 84];
    header[80..84].copy_from_slice(&(triangles as u32).to_le_bytes());
    sink.put_bytes(&header);
    let mut record = [0u8; 50];
    for t in 0..triangles {
        // Three points of a unit right triangle on a 1000-wide grid, lifted by `t % 7` at the
        // third so no triangle is flat or degenerate and the whole job can be rasterized.
        let (x, y) = ((t % 1000) as f32, ((t / 1000) % 1000) as f32);
        let corners = [x, y, 0.0, x + 1.0, y, 0.0, x, y + 1.0, (t % 7) as f32];
        for (i, value) in corners.iter().enumerate() {
            record[12 + i * 4..16 + i * 4].copy_from_slice(&value.to_le_bytes());
        }
        sink.put_bytes(&record);
    }
    let (mut file, _) = sink.finish();
    file.flush().unwrap();
}

/// `vertices` vertex lines and quads over them: a mesh with a vertex table, so the 12-byte term of
/// the README's formula is exercised as well as the 36-byte one.
fn write_obj(path: &Path, vertices: usize) -> (usize, usize) {
    let mut sink = Chunked::new(BufWriter::new(File::create(path).unwrap()));
    for i in 0..vertices {
        sink.put(&format!("v {i} {} {}\n", i % 97, i % 31));
    }
    let mut quads = 0;
    let mut i = 0;
    while i + 4 <= vertices {
        sink.put(&format!("f {} {} {} {}\n", i + 1, i + 2, i + 3, i + 4));
        quads += 1;
        i += 4;
    }
    let (mut file, _) = sink.finish();
    file.flush().unwrap();
    (vertices, quads * 2)
}

fn job_for(path: &Path, kind: FileKind) -> PreviewJob {
    PreviewJob {
        file_id: "memory-test".to_owned(),
        abs_path: path.to_path_buf(),
        kind,
        content_hash: None,
        claimed_at: 0,
    }
}

// --- the scenarios -------------------------------------------------------------------------

#[test]
fn nothing_is_read_whole_and_the_peak_is_the_mesh_plus_a_small_constant() {
    let dir = tempdir().unwrap();
    let limits = MeshLimits {
        max_mesh_bytes: u64::MAX,
    };
    let scale: usize = std::env::var("SPM_MEMORY_TEST_SCALE")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|scale| *scale >= 1)
        .unwrap_or(1);

    // ---- A 3MF whose model part inflates to ~60 MB -----------------------------------------
    let n = 800_000 * scale;
    let big_3mf = dir.path().join("big.3mf");
    let model_bytes = write_streamed_3mf(&big_3mf, |sink| generate_grid_model(sink, n, 0)) as usize;
    let file_bytes = std::fs::metadata(&big_3mf).unwrap().len() as usize;
    let mesh_bytes = mesh_bytes_for(n as u64, n as u64) as usize;

    let mut probe = ScanProbe::default();
    let resident_before = ALLOCATOR.current_usage();
    let (peak, mesh) =
        peak_above_baseline(|| parse_3mf_mesh_probed(&big_3mf, &limits, &mut probe).unwrap());
    assert_eq!(mesh.triangle_count, n);
    println!(
        "3MF: model part {:.1} MiB inflated ({:.1} MiB on disk), mesh {:.1} MiB, peak above baseline {:.1} MiB (overhead {:.2} MiB, window peaked at {} KiB)",
        mib(model_bytes),
        mib(file_bytes),
        mib(mesh_bytes),
        mib(peak),
        mib(peak.saturating_sub(mesh_bytes)),
        probe.peak_window_bytes / 1024,
    );
    assert!(
        peak >= mesh_bytes,
        "the instrument saw {peak} bytes, less than the {mesh_bytes}-byte mesh it must have allocated"
    );
    assert!(
        peak <= mesh_bytes + FIXED_OVERHEAD,
        "peak {:.1} MiB is more than the mesh ({:.1} MiB) plus {:.1} MiB",
        mib(peak),
        mib(mesh_bytes),
        mib(FIXED_OVERHEAD)
    );
    // Not read whole: the inflated model part is larger than everything the parse held at once.
    assert!(
        peak < model_bytes,
        "peak {:.1} MiB is not below the {:.1} MiB model part",
        mib(peak),
        mib(model_bytes)
    );
    assert!(probe.peak_window_bytes <= WINDOW_BYTES);
    // What the parse leaves behind is the triangles and nothing else (the vertex table it
    // resolved faces through is gone), and dropping them returns the process to where it started.
    let retained = ALLOCATOR.current_usage() - resident_before;
    assert!(
        retained <= n * 36 + FIXED_OVERHEAD / 8,
        "the parse retained {:.2} MiB for a {:.2} MiB triangle array",
        mib(retained),
        mib(n * 36)
    );
    drop(mesh);
    assert!(
        ALLOCATOR.current_usage() <= resident_before + FIXED_OVERHEAD / 8,
        "memory was left allocated after the mesh was dropped"
    );

    // ---- The same geometry behind a large comment: the file grows, the peak does not --------
    let small_3mf = dir.path().join("small.3mf");
    write_streamed_3mf(&small_3mf, |sink| generate_grid_model(sink, 20_000, 0));
    let padded_3mf = dir.path().join("padded.3mf");
    let padded_bytes = write_streamed_3mf(&padded_3mf, |sink| {
        generate_grid_model(sink, 20_000, 32 * MIB * scale);
    }) as usize;
    let (small_peak, small_mesh) = peak_above_baseline(|| {
        parse_3mf_mesh_probed(&small_3mf, &limits, &mut ScanProbe::default()).unwrap()
    });
    let (padded_peak, padded_mesh) = peak_above_baseline(|| {
        parse_3mf_mesh_probed(&padded_3mf, &limits, &mut ScanProbe::default()).unwrap()
    });
    assert_eq!(padded_mesh, small_mesh);
    println!(
        "3MF scales with the mesh, not the file: same 20k-triangle mesh, small document peak {:.2} MiB, document with a {:.0} MiB comment peak {:.2} MiB",
        mib(small_peak),
        mib(padded_bytes),
        mib(padded_peak)
    );
    assert!(
        padded_peak <= small_peak + MIB / 2,
        "a {:.0} MiB comment raised the peak from {:.2} to {:.2} MiB",
        mib(padded_bytes),
        mib(small_peak),
        mib(padded_peak)
    );
    drop((small_mesh, padded_mesh));

    // ---- A binary STL of ~57 MB -------------------------------------------------------------
    let triangles = 1_200_000 * scale;
    let big_stl = dir.path().join("big.stl");
    write_binary_stl(&big_stl, triangles);
    let stl_file_bytes = std::fs::metadata(&big_stl).unwrap().len() as usize;
    let stl_mesh_bytes = mesh_bytes_for(0, triangles as u64) as usize;
    let (peak, mesh) = peak_above_baseline(|| parse_stl_file(&big_stl, &limits).unwrap());
    assert_eq!(mesh.triangle_count, triangles);
    println!(
        "STL: file {:.1} MiB, mesh {:.1} MiB, peak above baseline {:.1} MiB (overhead {:.2} MiB)",
        mib(stl_file_bytes),
        mib(stl_mesh_bytes),
        mib(peak),
        mib(peak.saturating_sub(stl_mesh_bytes)),
    );
    assert!(peak >= stl_mesh_bytes);
    assert!(peak <= stl_mesh_bytes + FIXED_OVERHEAD);
    assert!(
        peak < stl_file_bytes,
        "peak {:.1} MiB is not below the {:.1} MiB file",
        mib(peak),
        mib(stl_file_bytes)
    );
    drop(mesh);

    // ---- An OBJ, which carries a vertex table as well as the triangles -----------------------
    let big_obj = dir.path().join("big.obj");
    let (obj_vertices, obj_triangles) = write_obj(&big_obj, 1_000_000 * scale);
    let obj_mesh_bytes = mesh_bytes_for(obj_vertices as u64, obj_triangles as u64) as usize;
    let (peak, mesh) = peak_above_baseline(|| parse_obj_file(&big_obj, &limits).unwrap());
    assert_eq!(mesh.triangle_count, obj_triangles);
    println!(
        "OBJ: mesh {:.1} MiB (vertex table + triangles), peak above baseline {:.1} MiB (overhead {:.2} MiB)",
        mib(obj_mesh_bytes),
        mib(peak),
        mib(peak.saturating_sub(obj_mesh_bytes)),
    );
    assert!(peak >= obj_mesh_bytes);
    assert!(peak <= obj_mesh_bytes + FIXED_OVERHEAD);
    drop(mesh);

    // ---- The whole preview job: parse, rasterize, encode -------------------------------------
    // What the queue's worker holds: the mesh, plus a 256x256 frame (RGB 192 KiB and f32 depth
    // 256 KiB) and the encoded PNG. The mesh is dropped before the PNG is built.
    let handler = MeshHandler::new(limits);
    let (peak, output) = peak_above_baseline(|| {
        handler
            .run(&job_for(&big_3mf, FileKind::Model))
            .unwrap()
            .expect("a 3MF renders")
    });
    println!(
        "whole job (3MF parse + rasterize + PNG): peak above baseline {:.1} MiB for a {:.1} MiB mesh, {} byte PNG",
        mib(peak),
        mib(mesh_bytes),
        output.bytes.len()
    );
    assert_eq!((output.width, output.height), (256, 256));
    assert!(peak <= mesh_bytes + FIXED_OVERHEAD + MIB);
    drop(output);
    let (peak, output) = peak_above_baseline(|| {
        handler
            .run(&job_for(&big_stl, FileKind::Model))
            .unwrap()
            .expect("an STL renders")
    });
    println!(
        "whole job (STL parse + rasterize + PNG): peak above baseline {:.1} MiB for a {:.1} MiB mesh",
        mib(peak),
        mib(stl_mesh_bytes),
    );
    assert!(peak <= stl_mesh_bytes + FIXED_OVERHEAD + MIB);
    drop(output);
}
