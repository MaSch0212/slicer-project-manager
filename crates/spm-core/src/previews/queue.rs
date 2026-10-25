//! The preview queue: claiming, bounded concurrency, the attempts counter, `source_hash`, and the
//! state machine `pending -> ready | failed | unsupported`.
//!
//! # How a host runs it
//!
//! [`run_preview_batch`] is the whole entry point. It is synchronous and takes no runtime: it
//! claims up to a batch of pending rows, renders them on up to `concurrency` threads it spawns
//! itself, writes each outcome back, and returns what happened. A host calls it on a timer:
//!
//! * a server wraps it in `spawn_blocking` from a `tokio::time::interval` tick (an overlapping
//!   tick is harmless: claimed rows are invisible to the next run);
//! * a Tauri app runs it on its own background thread, or just uses [`super::PreviewWorker`],
//!   which is that loop.
//!
//! One slow run does not block the process: nothing here holds the database lock while a model is
//! parsed or rendered, only for the claim and for each result's write.

use std::any::Any;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use rusqlite::{TransactionBehavior, params, params_from_iter};

use super::handlers::{embedded_handler, make_preview_handlers};
use super::mesh::limits::MeshLimits;
use crate::clock::now_ms;
use crate::db::{Library, PREVIEWS_DIR, SPM_DIR};
use crate::dto::FileKind;
use crate::error::{AppError, AppErrorCode, Result};
use crate::fields;
use crate::files::paths::preview_path;
use crate::log::LogValue;
use crate::projects::rescan::RELATIVE_PATH_SEPARATOR;

/// A preview job: one file, and the lease it was handed the row under.
#[derive(Debug, Clone)]
pub struct PreviewJob {
    pub file_id: String,
    pub abs_path: PathBuf,
    pub kind: FileKind,
    pub content_hash: Option<Vec<u8>>,
    /// The exact `claimed_at` [`claim_pending_previews`] wrote. It is what the result is written
    /// back *against*, so a result is only recorded while the row is still the one that was
    /// claimed. See [`finish`].
    pub claimed_at: i64,
}

/// Where a picture came from, as `previews.source` spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewSource {
    /// The thumbnail the slicer wrote into the file.
    Embedded,
    /// Drawn by the software rasterizer.
    Rasterized,
}

impl PreviewSource {
    pub fn as_str(self) -> &'static str {
        match self {
            PreviewSource::Embedded => "embedded",
            PreviewSource::Rasterized => "rasterized",
        }
    }
}

/// What a handler produced: PNG bytes, their size, and where they came from.
#[derive(Debug, Clone)]
pub struct PreviewOutput {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source: PreviewSource,
}

/// A handler declares the kinds it covers; anything uncovered is left pending.
///
/// **`Ok(None)` and `Err` are different outcomes, and the difference is the point.** `Ok(None)` is
/// "there is deterministically nothing to render here" and the queue records `unsupported` (after
/// asking the next handler); `Err` is "this file should have rendered and did not", which the
/// queue records as `failed`, with the message.
pub trait PreviewHandler: Send + Sync {
    fn kinds(&self) -> &[FileKind];
    fn run(&self, job: &PreviewJob) -> Result<Option<PreviewOutput>>;
}

/// A shared handler, as the queue holds them: one value serves every worker thread.
pub type SharedHandler = Arc<dyn PreviewHandler>;

struct ClosureHandler<F> {
    kinds: Vec<FileKind>,
    run: F,
}

impl<F> PreviewHandler for ClosureHandler<F>
where
    F: Fn(&PreviewJob) -> Result<Option<PreviewOutput>> + Send + Sync,
{
    fn kinds(&self) -> &[FileKind] {
        &self.kinds
    }

    fn run(&self, job: &PreviewJob) -> Result<Option<PreviewOutput>> {
        (self.run)(job)
    }
}

/// A handler made from a closure, for callers that have no type of their own to implement the
/// trait on.
pub fn handler_from_fn<F>(kinds: &[FileKind], run: F) -> SharedHandler
where
    F: Fn(&PreviewJob) -> Result<Option<PreviewOutput>> + Send + Sync + 'static,
{
    Arc::new(ClosureHandler {
        kinds: kinds.to_vec(),
        run,
    })
}

/// Bounds how often one row may be *claimed* while it is still `pending` (spec 7.3).
///
/// Narrower than it sounds. A handler that returns or fails moves the row to a terminal state in
/// the same run, and the claim selects only `state = 'pending'`, so an ordinary failure is not
/// what this bounds: reaching the terminal state is. What this bounds is the row that never gets
/// one: a job that hangs, or a process killed mid-run, leaves `pending` with a lease that later
/// expires and is re-claimed. Without a ceiling that file is picked up again on every restart,
/// forever.
///
/// A rescan resets `attempts` to 0 along with the state whenever it re-pends the row (the file's
/// content hash changed, or a `CLASSIFIER_VERSION` bump gave it a different kind), so the budget
/// is per unchanged-bytes-and-kind, not per file for all time.
pub const MAX_PREVIEW_ATTEMPTS: i64 = 3;

/// How many preview jobs run at once by default.
///
/// **One, and that is a memory decision rather than a throughput one.** A rasterizing job's peak
/// is its mesh plus a fixed reader window, and the reference library's largest mesh is 208.8 MB,
/// so a worker is worth about that at the worst. The deployment target is a 2 GB NAS with a 500 MB
/// budget, and every extra worker may hold one more whole mesh: `concurrency x one mesh` is the
/// formula, and the README's "Preview memory" section carries the table. Raise it for a library
/// that waits on I/O, or on a machine with cores and memory to spare (the parse and the
/// rasterizer are CPU-bound, and unlike the first implementation of this queue they now run on
/// separate threads, so a second worker does buy throughput).
///
/// There is no STEP term in that arithmetic any more: STEP is not read, so there is no
/// geometry-kernel floor to budget for.
pub const DEFAULT_CONCURRENCY: usize = 1;

/// How many rows one batch claims at most.
pub const DEFAULT_BATCH_LIMIT: usize = 100;

/// How long a claim on a preview row is honoured. Well beyond any single job (the rasterizer
/// against a 54 MB 3MF is minutes at worst), so it never cuts a live job short; short enough that
/// a killed process does not strand a row until the next rescan.
pub const PREVIEW_LEASE_MS: i64 = 15 * 60 * 1000;

/// A row's outcome counts. `claimed` is how many rows the run took; the other three count only
/// outcomes that were actually recorded (a result dropped because a rescan moved the row on is
/// counted nowhere).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BatchResult {
    pub claimed: usize,
    pub ready: usize,
    pub failed: usize,
    pub unsupported: usize,
}

/// What [`run_preview_queue`] takes: how many jobs at once, how many rows per run, and the
/// handlers, tried in order for a job's kind.
#[derive(Clone)]
pub struct QueueOptions {
    pub concurrency: usize,
    pub limit: usize,
    pub handlers: Vec<SharedHandler>,
}

impl Default for QueueOptions {
    /// One worker, a batch of 100, and the **narrow** handler: `slicer_project` only.
    ///
    /// A plain `model` 3MF can carry a thumbnail too, and one should be used when it is there, but
    /// covering `model` here would be wrong, because coverage is a claim and a claim that comes
    /// back `None` is recorded as `unsupported`, which is terminal. Alone in the list this handler
    /// has nothing behind it, so every `.stl` and `.obj` (not a zip, no thumbnail) would go
    /// permanently blank instead of staying `pending` for a host that enables the rasterizer
    /// later. Deciding to spend CPU rasterizing belongs to whoever runs the library, which is
    /// what [`PreviewConfig`] and [`make_preview_handlers`] are.
    fn default() -> Self {
        QueueOptions {
            concurrency: DEFAULT_CONCURRENCY,
            limit: DEFAULT_BATCH_LIMIT,
            handlers: vec![embedded_handler()],
        }
    }
}

/// What a host configures: the production handler chain, with the knobs the README documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewConfig {
    /// How many thumbnails are rendered at once (`SPM_PREVIEW_CONCURRENCY`). Each worker may hold
    /// one whole mesh, so this multiplies the mesh part of the queue's memory.
    pub concurrency: usize,
    /// How many rows one batch claims at most.
    pub limit: usize,
    /// The ceiling on one mesh (`SPM_MAX_MESH_MB`).
    pub limits: MeshLimits,
}

impl Default for PreviewConfig {
    fn default() -> Self {
        PreviewConfig {
            concurrency: DEFAULT_CONCURRENCY,
            limit: DEFAULT_BATCH_LIMIT,
            limits: MeshLimits::default(),
        }
    }
}

/// Runs one batch of the production chain: an embedded thumbnail where the file has one, the
/// rasterizer where it does not. **The queue entry point a host calls on an interval.**
///
/// Synchronous; spawns `config.concurrency` threads for the duration of the call and joins them
/// before it returns. Silent when there was nothing to do (an idle library would otherwise log a
/// zeroed line every interval); otherwise logs one `preview batch` summary at info.
pub fn run_preview_batch(lib: &Library, config: &PreviewConfig) -> Result<BatchResult> {
    run_preview_queue(
        lib,
        &QueueOptions {
            concurrency: config.concurrency,
            limit: config.limit,
            handlers: make_preview_handlers(&config.limits),
        },
    )
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// Takes ownership of up to `limit` pending rows and returns them as jobs.
///
/// This *claims*: it writes `claimed_at` (the lease) and increments `attempts` before the caller
/// runs anything.
///
/// - **Claiming, not just selecting.** The queue is fired on a fixed interval with no guarantee a
///   batch finishes inside it. Selecting on `state = 'pending'` alone would let the next tick
///   re-select the identical rows and redo the whole batch, compounding every tick once a job is
///   slower than the interval. A row with a live lease is invisible here.
/// - **Atomic.** The select and the update run in one `IMMEDIATE` transaction, so another
///   `run_preview_queue` (a second thread, or a second process on the same library file) can only
///   observe the rows before or after both statements, never between them.
/// - **`attempts` moves here, not on failure.** Incrementing only on a failed run would mean a
///   handler that hung or a process that died never counted, so the same malformed file would be
///   retried forever across restarts, which is exactly what spec 7.3's retry budget bounds.
/// - **An expired lease is reclaimable**, so a crash costs one attempt rather than stranding the
///   row until the next rescan.
/// - **The lease is also the job's write token.** `claimed_at` goes onto the [`PreviewJob`], and
///   the outcome is written back only while the row still carries it. Without that, a rescan that
///   re-pends a file mid-render had the stale result written straight over the row it had reset.
pub fn claim_pending_previews(
    lib: &Library,
    handlers: &[SharedHandler],
    limit: usize,
    now: i64,
) -> Result<Vec<PreviewJob>> {
    let mut kinds: Vec<&'static str> = Vec::new();
    for kind in handlers.iter().flat_map(|handler| handler.kinds()) {
        if !kinds.contains(&kind.as_str()) {
            kinds.push(kind.as_str());
        }
    }
    if kinds.is_empty() {
        return Ok(Vec::new());
    }

    struct Row {
        file_id: String,
        kind: String,
        rel_path: String,
        content_hash: Option<Vec<u8>>,
        dir_name: String,
        library_dir: String,
    }

    let rows = {
        let mut conn = lib.db();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows: Vec<Row> = {
            let sql = format!(
                "SELECT pv.file_id, f.kind, f.rel_path, f.content_hash, p.dir_name, u.library_dir
                 FROM previews pv
                 JOIN files f ON f.id = pv.file_id
                 JOIN projects p ON p.id = f.project_id
                 JOIN users u ON u.id = p.owner_id
                 WHERE pv.state = 'pending' AND pv.attempts < ? AND p.state = 'ok'
                   AND (pv.claimed_at IS NULL OR pv.claimed_at <= ?)
                   AND f.kind IN ({})
                 ORDER BY pv.updated_at
                 LIMIT ?",
                placeholders(kinds.len())
            );
            let mut statement = tx.prepare(&sql)?;
            let mut values: Vec<rusqlite::types::Value> =
                vec![MAX_PREVIEW_ATTEMPTS.into(), (now - PREVIEW_LEASE_MS).into()];
            values.extend(kinds.iter().map(|kind| (*kind).to_owned().into()));
            values.push(i64::try_from(limit).unwrap_or(i64::MAX).into());
            statement
                .query_map(params_from_iter(values), |row| {
                    Ok(Row {
                        file_id: row.get(0)?,
                        kind: row.get(1)?,
                        rel_path: row.get(2)?,
                        content_hash: row.get(3)?,
                        dir_name: row.get(4)?,
                        library_dir: row.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?
        };
        {
            let mut claim = tx.prepare(
                "UPDATE previews SET claimed_at = ?, attempts = attempts + 1 WHERE file_id = ?",
            )?;
            for row in &rows {
                claim.execute(params![now, row.file_id])?;
            }
        }
        tx.commit()?;
        rows
    };
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    lib.log()
        .debug("claimed preview jobs", fields!["count" => rows.len()]);

    Ok(rows
        .into_iter()
        .map(|row| {
            let mut abs_path = lib.dir().to_path_buf();
            if row.library_dir != "." {
                abs_path.push(&row.library_dir);
            }
            abs_path.push(&row.dir_name);
            abs_path.extend(row.rel_path.split(RELATIVE_PATH_SEPARATOR));
            PreviewJob {
                file_id: row.file_id,
                kind: FileKind::parse(&row.kind).unwrap_or(FileKind::Other),
                content_hash: row.content_hash,
                claimed_at: now,
                abs_path,
            }
        })
        .collect())
}

/// Writes one job's outcome, **and only while the row is still the one that job claimed**.
///
/// Every terminal write goes through here, and every one of them carries the same two extra
/// conditions: `state = 'pending'` (a claimed row is still pending: the claim writes only
/// `claimed_at` and `attempts`) and `claimed_at = <this job's lease>`. Together they say "nobody
/// has touched this row since I took it".
///
/// **The bug this closes.** `rescan` re-pends a file whose content hash changed (`state =
/// 'pending'`, `claimed_at = NULL`, `attempts = 0`) whether or not a job is in flight for that
/// file. With the write unguarded, the in-flight job then wrote `state = 'ready'` over the fresh
/// `pending` row with the picture it had rendered from the *old* bytes, and `source_hash` set to
/// the old hash. Nothing recovered from it: the same rescan had already written the new size and
/// mtime, so the next rescan takes the cheap stat-match path and never looks at `source_hash`
/// again. The user's edited model kept its pre-edit thumbnail for as long as the file stayed
/// untouched. Guarded, the stale result is dropped and the row is left `pending` for the next
/// run, which renders the bytes that are actually there.
///
/// **What it does not make atomic, and this is the honest bound.** The PNG is written to
/// `<fileId>.png` before this runs, so a dropped result has already replaced the bytes at that
/// path. That is harmless where it matters (a `pending` row's `png_path` is NULL, so nothing
/// serves those bytes, and the run that re-renders the file overwrites them), but the pair is not
/// transactional.
///
/// Returns whether the write landed, so the caller can count only outcomes it actually recorded.
fn finish(
    lib: &Library,
    job: &PreviewJob,
    sql: &str,
    values: Vec<rusqlite::types::Value>,
) -> Result<bool> {
    let mut values = values;
    values.push(job.claimed_at.into());
    let changes = lib.db().execute(
        &format!("{sql} AND state = 'pending' AND claimed_at = ?"),
        params_from_iter(values),
    )?;
    if changes == 1 {
        return Ok(true);
    }
    // debug, not warn: the only way here is a row somebody else moved on purpose (today that is
    // `rescan`, re-pending either an edited file or one a classifier bump gave a new kind), and
    // the queue picking it up again is the right answer, not an incident.
    lib.log().debug(
        "preview result dropped, the row was no longer the one claimed",
        fields!["fileId" => &job.file_id],
    );
    Ok(false)
}

#[derive(Default)]
struct Counts {
    ready: AtomicUsize,
    failed: AtomicUsize,
    unsupported: AtomicUsize,
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned())
}

/// The text a failed row carries: what a person debugging the file needs, capped at 500
/// characters. An `Internal` error's message is the generic "internal error"; its cause is the
/// part that says what happened.
fn failure_message(error: &AppError) -> String {
    let text = match (error.code, &error.cause) {
        (AppErrorCode::Internal, Some(cause)) => cause.as_str(),
        _ => error.message.as_str(),
    };
    text.chars().take(500).collect()
}

/// Every matching handler in order, first non-`None` wins.
///
/// `None` means "not my job, ask the next one", so a slicer project whose slicer embedded no
/// thumbnail falls through from the embedded handler to the rasterizer instead of ending
/// `unsupported`, which the queue never revisits.
///
/// A failure is the *other* answer: "this file is broken". It leaves the loop immediately and is
/// recorded as `failed`. That is why nothing here catches an error to try the next handler: doing
/// so would record the corrupt model as `unsupported`, which writes `error = NULL`, the same row a
/// genuinely unrenderable file gets, with nothing left to say which it was or why.
///
/// A panic in a handler is turned into the same failure, so one bad file cannot take the batch
/// (or the host's worker thread) down with it. That holds for builds that unwind, which includes
/// the workspace's release profile: it must not set `panic = "abort"`, where a panic anywhere in
/// the process ends it and `catch_unwind` has nothing to catch (a test in `spm-server` reads the
/// profile to keep it that way). The parsers return errors for everything a file can cause, so
/// this is the second line of defence against a parser bug, not the first.
fn produce(job: &PreviewJob, matching: &[&SharedHandler]) -> Result<Option<PreviewOutput>> {
    let run = || -> Result<Option<PreviewOutput>> {
        for handler in matching {
            if let Some(output) = handler.run(job)? {
                return Ok(Some(output));
            }
        }
        Ok(None)
    };
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(result) => result,
        Err(payload) => Err(AppError::internal(format!(
            "preview handler panicked: {}",
            panic_message(payload.as_ref())
        ))),
    }
}

fn run_one(
    lib: &Library,
    job: &PreviewJob,
    handlers: &[SharedHandler],
    counts: &Counts,
) -> Result<()> {
    let matching: Vec<&SharedHandler> = handlers
        .iter()
        .filter(|handler| handler.kinds().contains(&job.kind))
        .collect();
    if matching.is_empty() {
        // Unreachable via `claim_pending_previews`, which only claims covered kinds; releasing
        // the lease anyway keeps a hand-built job list from parking a row for PREVIEW_LEASE_MS.
        // Guarded like every other write here, so a release cannot land on somebody else's claim.
        finish(
            lib,
            job,
            "UPDATE previews SET claimed_at = NULL WHERE file_id = ?",
            vec![job.file_id.clone().into()],
        )?;
        return Ok(());
    }

    let now = now_ms();
    let produced = produce(job, &matching).and_then(|output| match output {
        None => Ok(None),
        Some(output) => {
            fs::write(preview_path(lib, &job.file_id), &output.bytes)?;
            Ok(Some(output))
        }
    });

    match produced {
        Ok(None) => {
            // Deterministic absence. Like `failed`, this leaves the queue for good: the claim
            // selects `state = 'pending'` only, so neither is ever re-claimed on its own. What
            // brings a row back is `rescan`, which re-pends it (attempts reset) when the file's
            // content hash changes, or when a `CLASSIFIER_VERSION` bump reclassifies it to a
            // *different* kind. So this is "nothing to render from these bytes", not "nothing to
            // render, ever".
            if finish(
                lib,
                job,
                "UPDATE previews SET state = 'unsupported', error = NULL, claimed_at = NULL,
                                     updated_at = ?
                 WHERE file_id = ?",
                vec![now.into(), job.file_id.clone().into()],
            )? {
                lib.log().debug(
                    "preview unsupported",
                    fields!["fileId" => &job.file_id, "kind" => job.kind.as_str()],
                );
                counts.unsupported.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(Some(output)) => {
            let png_path = [SPM_DIR, PREVIEWS_DIR, &format!("{}.png", job.file_id)]
                .join(RELATIVE_PATH_SEPARATOR);
            if finish(
                lib,
                job,
                "UPDATE previews SET state = 'ready', source = ?, png_path = ?, width = ?, height = ?,
                                     source_hash = ?, error = NULL, claimed_at = NULL, updated_at = ?
                 WHERE file_id = ?",
                vec![
                    output.source.as_str().to_owned().into(),
                    png_path.into(),
                    i64::from(output.width).into(),
                    i64::from(output.height).into(),
                    job.content_hash.clone().into(),
                    now.into(),
                    job.file_id.clone().into(),
                ],
            )? {
                lib.log().debug(
                    "preview ready",
                    fields![
                        "fileId" => &job.file_id,
                        "source" => output.source.as_str(),
                        "width" => output.width,
                        "height" => output.height,
                    ],
                );
                counts.ready.fetch_add(1, Ordering::Relaxed);
            }
        }
        Err(error) => {
            // `attempts` is NOT incremented here: the claim already charged this attempt, so
            // doing it again would halve the retry budget for the failures it is meant to bound.
            // The lease is released, because this row has reached a terminal state.
            if finish(
                lib,
                job,
                "UPDATE previews SET state = 'failed', error = ?, claimed_at = NULL, updated_at = ?
                 WHERE file_id = ?",
                vec![
                    failure_message(&error).into(),
                    now.into(),
                    job.file_id.clone().into(),
                ],
            )? {
                // warn, not error: a single malformed file is expected traffic for an importer,
                // and MAX_PREVIEW_ATTEMPTS already bounds it. The path is what makes it
                // actionable.
                lib.log().warn(
                    "preview failed",
                    fields![
                        "fileId" => &job.file_id,
                        "path" => job.abs_path.to_string_lossy().into_owned(),
                        "err" => LogValue::error(&failure_message(&error)),
                    ],
                );
                counts.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    Ok(())
}

/// Runs one batch of `options.handlers`, with `options.concurrency` jobs at a time.
///
/// The workers are scoped threads pulling jobs off one shared counter, and with one worker (the
/// default) the jobs run on the calling thread and nothing is spawned at all. A database failure
/// while recording one job's outcome is logged at error and does not stop the others: that row
/// keeps its lease and is retried once it expires, which costs it an attempt, as a crash would.
///
/// Silent when there was nothing to do, otherwise one `preview batch` line at info.
pub fn run_preview_queue(lib: &Library, options: &QueueOptions) -> Result<BatchResult> {
    let jobs = claim_pending_previews(lib, &options.handlers, options.limit, now_ms())?;
    let counts = Counts::default();
    let next = AtomicUsize::new(0);

    let work = || {
        loop {
            let index = next.fetch_add(1, Ordering::Relaxed);
            let Some(job) = jobs.get(index) else {
                return;
            };
            if let Err(error) = run_one(lib, job, &options.handlers, &counts) {
                lib.log().error(
                    "recording a preview result failed",
                    fields!["fileId" => &job.file_id, "err" => LogValue::error(&error)],
                );
            }
        }
    };
    let width = options.concurrency.clamp(1, jobs.len().max(1));
    if width == 1 {
        work();
    } else {
        thread::scope(|scope| {
            for _ in 0..width {
                scope.spawn(work);
            }
        });
    }

    let result = BatchResult {
        claimed: jobs.len(),
        ready: counts.ready.load(Ordering::Relaxed),
        failed: counts.failed.load(Ordering::Relaxed),
        unsupported: counts.unsupported.load(Ordering::Relaxed),
    };
    // Silent when there was nothing to do: this runs every few seconds and an idle library would
    // otherwise fill the log with zeroes at the default level.
    if result.claimed > 0 {
        lib.log().info(
            "preview batch",
            fields![
                "claimed" => result.claimed,
                "ready" => result.ready,
                "failed" => result.failed,
                "unsupported" => result.unsupported,
            ],
        );
    }
    Ok(result)
}
