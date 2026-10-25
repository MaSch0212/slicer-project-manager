//! Running the server: the library, the router, the preview queue and the housekeeping tasks.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use spm_core::log::{LogLevelSetting, LogValue, console_sink};
use spm_core::previews::MeshLimits;
use spm_core::{
    AppError, BatchResult, Library, Logger, OpenOptions, PreviewConfig, ensure_bootstrap_admin,
    fields, run_preview_batch,
};
use spm_http::{AppState, AuthMode, DevProxy, HttpOptions, UiSource, router};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::env::{REMOVED_STEP_VARIABLE, ServerEnv};
use crate::web::ui_source;

/// How many preview rows one pass of the queue claims. The queue runs again after every interval,
/// so this bounds latency between passes, not memory (concurrency does that).
pub const PREVIEW_BATCH_LIMIT: usize = 20;

pub const PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// The preview configuration for a server environment.
pub fn preview_config(env: &ServerEnv) -> PreviewConfig {
    PreviewConfig {
        concurrency: env.preview_concurrency,
        limit: PREVIEW_BATCH_LIMIT,
        limits: MeshLimits {
            max_mesh_bytes: env.max_mesh_bytes,
        },
    }
}

/// The logger every part of the server shares: the configured level, to the console.
pub fn console_logger(level: LogLevelSetting) -> Logger {
    Logger::with_sink(level, Arc::new(console_sink))
}

/// Opens the library at `env.library_dir` with `log` as its logger.
pub fn open_library(env: &ServerEnv, log: &Logger) -> Result<Library, String> {
    Library::open(
        &env.library_dir,
        OpenOptions {
            logger: Some(log.clone()),
            ..OpenOptions::default()
        },
    )
    .map_err(|error| {
        format!(
            "could not open the library at {}: {}",
            env.library_dir,
            error.cause.as_deref().unwrap_or(&error.message)
        )
    })
}

/// First run against an empty library creates a `pending` admin and prints its activation path.
///
/// No default password exists anywhere; this link is the only way in. It is a bare line on
/// stdout rather than a log record: it is a one-off instruction to the operator, and it must
/// survive `SPM_LOG_LEVEL=silent` or the first run is unrecoverable.
pub fn announce_bootstrap(lib: &Library) -> Result<(), AppError> {
    announce_bootstrap_to(lib, &mut std::io::stdout())
}

/// [`announce_bootstrap`] with the output stream chosen by the caller.
pub fn announce_bootstrap_to(lib: &Library, out: &mut dyn std::io::Write) -> Result<(), AppError> {
    if let Some(boot) = ensure_bootstrap_admin(lib)? {
        let _ = writeln!(
            out,
            "First run: activate \"{}\" at /activate#{}",
            boot.username, boot.token
        );
        let _ = out.flush();
    }
    Ok(())
}

/// Warns about a variable that is set but no longer read.
pub fn warn_removed_variables(log: &Logger, is_set: &dyn Fn(&str) -> bool) {
    if is_set(REMOVED_STEP_VARIABLE) {
        log.warn(
            "SPM_MAX_STEP_MB is ignored: STEP previews were removed and the variable with them",
            fields![],
        );
    }
}

/// The state the router is built from, for this environment.
pub fn app_state(lib: &Library, env: &ServerEnv, log: &Logger) -> AppState {
    let ui = match &env.dev_ui_origin {
        Some(origin) => UiSource::DevProxy(DevProxy::new(origin.clone(), log.clone())),
        None => ui_source(env.web_root.clone()),
    };
    AppState::new(
        lib.clone(),
        HttpOptions {
            auth: AuthMode::Sessions,
            public_origin: env.public_origin.clone(),
            ui,
            logger: Some(log.clone()),
            clock: None,
        },
    )
}

/// Runs the preview queue every `interval`, forever. See [`run_passes`].
pub async fn preview_loop(lib: Library, config: PreviewConfig, interval: Duration, log: Logger) {
    run_passes(lib, interval, log, move |lib| {
        run_preview_batch(lib, &config)
    })
    .await;
}

/// Calls `pass` on the blocking pool once per `interval`, forever.
///
/// Each pass finishes before the next is considered, so passes never overlap however slow one is;
/// core's claim-with-a-lease makes an overlap harmless anyway (a second process on the same
/// library, say), and `Delay` means a slow pass does not queue up a burst of catch-up passes
/// behind it. The first pass is one interval after startup.
///
/// A failed pass, or a panic inside one, is logged and the loop carries on: one bad model must
/// not stop previews for the rest of the library. A panic only gets this far in a build that
/// unwinds, which is why the release profile does not set `panic = "abort"`.
pub async fn run_passes<F>(lib: Library, interval: Duration, log: Logger, pass: F)
where
    F: Fn(&Library) -> Result<BatchResult, AppError> + Send + Sync + 'static,
{
    let pass = Arc::new(pass);
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let (worker_lib, worker_pass) = (lib.clone(), Arc::clone(&pass));
        match tokio::task::spawn_blocking(move || worker_pass(&worker_lib)).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => log.error(
                "preview queue run failed",
                fields!["err" => LogValue::error(&error)],
            ),
            Err(joined) => log.error(
                "preview queue run failed",
                fields!["err" => LogValue::error(&joined)],
            ),
        }
    }
}

/// Deletes expired sessions every [`PRUNE_INTERVAL`], forever.
pub async fn prune_loop(lib: Library, log: Logger) {
    let mut ticker =
        tokio::time::interval_at(tokio::time::Instant::now() + PRUNE_INTERVAL, PRUNE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let worker_lib = lib.clone();
        let pruned = tokio::task::spawn_blocking(move || {
            spm_core::auth::sessions::prune_expired_sessions(&worker_lib, spm_core::clock::now_ms())
        })
        .await;
        match pruned {
            Ok(Ok(count)) if count > 0 => {
                log.info("pruned expired sessions", fields!["count" => count]);
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => log.error(
                "pruning sessions failed",
                fields!["err" => LogValue::error(&error)],
            ),
            Err(joined) => log.error(
                "pruning sessions failed",
                fields!["err" => LogValue::error(&joined)],
            ),
        }
    }
}

/// Serves `lib` on `listener` until `shutdown` resolves, with the preview queue and the session
/// pruning running beside it.
///
/// Returns when the server has drained its in-flight requests. The background tasks are stopped
/// without waiting for a pass that is mid-render: a render cannot be interrupted, every write it
/// makes is its own transaction, and the lease on its rows expires on its own.
pub async fn run(
    lib: Library,
    env: &ServerEnv,
    log: Logger,
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let background: Vec<JoinHandle<()>> = vec![
        tokio::spawn(preview_loop(
            lib.clone(),
            preview_config(env),
            Duration::from_millis(env.preview_interval_ms),
            log.clone(),
        )),
        tokio::spawn(prune_loop(lib.clone(), log.clone())),
    ];

    let app =
        router(app_state(&lib, env, &log)).into_make_service_with_connect_info::<SocketAddr>();
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await;

    for task in background {
        task.abort();
    }
    served
}

/// Resolves on Ctrl-C, or SIGTERM where there is one (what `docker stop` sends).
pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            // No signal handler could be installed: never resolve rather than shut down at once.
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

/// The whole of `spm-server` with no arguments: validate the environment (the caller already
/// has), open the library, bootstrap, listen, serve until a signal, shut down.
///
/// Every failure that is the operator's to fix comes back as one line for `main` to print.
pub async fn serve_from_env(env: ServerEnv) -> Result<(), String> {
    // All interfaces unless SPM_HOST says otherwise: the container's published port reaches the
    // process through its own address.
    let bind = env
        .host
        .unwrap_or_else(|| std::net::Ipv4Addr::UNSPECIFIED.into());
    serve_on(env, bind, shutdown_signal()).await
}

/// [`serve_from_env`] on a chosen address and with a chosen shutdown trigger, so a test can run
/// the whole startup sequence on loopback.
pub async fn serve_on(
    env: ServerEnv,
    bind: std::net::IpAddr,
    stop: impl Future<Output = ()> + Send + 'static,
) -> Result<(), String> {
    let log = console_logger(env.level);
    let lib = open_library(&env, &log)?;
    log.info(
        "library opened",
        fields!["dir" => lib.dir().display().to_string(), "logLevel" => env.level.as_str()],
    );

    announce_bootstrap(&lib).map_err(|error| {
        format!(
            "could not create the first administrator: {}",
            error.cause.as_deref().unwrap_or(&error.message)
        )
    })?;

    warn_removed_variables(&log, &|name| std::env::var_os(name).is_some());
    // Development only: everything outside /api/ is forwarded to a running dev server, so one
    // origin serves both halves of the app and the UI does not have to be rebuilt to be seen.
    if let Some(origin) = &env.dev_ui_origin {
        log.warn(
            "serving the UI from the dev server",
            fields!["origin" => origin],
        );
    }

    let listener = TcpListener::bind((bind, env.port))
        .await
        .map_err(|error| format!("could not listen on port {}: {error}", env.port))?;
    log.info(
        "listening",
        fields!["url" => format!("http://localhost:{}", env.port)],
    );

    let shutdown_log = log.clone();
    run(lib, &env, log, listener, async move {
        stop.await;
        shutdown_log.info("shutting down", fields![]);
    })
    .await
    .map_err(|error| format!("the server stopped: {error}"))
}
