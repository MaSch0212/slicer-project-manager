//! Previews: the 256x256 PNG shown for a file.
//!
//! Parent spec section 7. A file's preview is, in order of preference, the thumbnail its slicer
//! embedded ([`embedded`]) or a picture drawn from its geometry: [`mesh`] parses STL, OBJ and 3MF
//! into triangle soup without holding the file, [`raster`] draws it with a fixed isometric camera
//! and a z-buffer, [`png`] encodes it. [`queue`] runs the whole thing over the `previews` table:
//! claiming a batch, rendering it on a bounded number of threads, writing outcomes back through
//! the state machine `pending -> ready | failed | unsupported`, and leaving
//! `.spm/previews/<file id>.png` behind.
//!
//! STEP is not read (migration spec 4.1). A `.step`/`.stp` file's preview is `unsupported`, and a
//! preview already `ready` for one in an existing library is left alone.
//!
//! # Scheduling
//!
//! [`run_preview_batch`] is the entry point: synchronous, no runtime, safe to call from any
//! thread. A server calls it from an interval inside `spawn_blocking`; a desktop app starts a
//! [`PreviewWorker`]. Concurrency is `PreviewConfig::concurrency` scoped std threads.
//!
//! # Memory
//!
//! Nothing is read whole. A 164 MB STL and a 3MF whose model part inflates to 674 MB both pass
//! through a fixed 256 KB window, so what is left in the peak is the mesh at 36 bytes per
//! triangle plus 12 per distinct vertex (3MF and OBJ), and a decompressor that costs kilobytes.
//! `tests/memory.rs` measures it with a counting allocator.

pub mod embedded;
pub mod handlers;
pub mod mesh;
pub mod mesh_handler;
pub mod png;
pub mod queue;
pub mod raster;
pub mod worker;

pub use handlers::{embedded_handler, make_preview_handlers};
pub use mesh::Mesh;
pub use mesh::limits::{DEFAULT_MAX_MESH_BYTES, MeshLimits};
pub use mesh_handler::MeshHandler;
pub use queue::{
    BatchResult, DEFAULT_BATCH_LIMIT, DEFAULT_CONCURRENCY, MAX_PREVIEW_ATTEMPTS, PREVIEW_LEASE_MS,
    PreviewConfig, PreviewHandler, PreviewJob, PreviewOutput, PreviewSource, QueueOptions,
    SharedHandler, claim_pending_previews, handler_from_fn, run_preview_batch, run_preview_queue,
};
pub use worker::PreviewWorker;
