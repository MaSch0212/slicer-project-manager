//! `spm-server`: the Slicer Project Manager server.
//!
//! * `spm-server`: serve the library named by `SPM_LIBRARY_DIR` (see the README's Environment
//!   table for every `SPM_*` variable).
//! * `spm-server import-curamanager <library-dir> <username> [--in-place]`: adopt a CuraManager
//!   library into a user's folder.

use std::io::Write;
use std::process::ExitCode;
use std::time::Duration;

use spm_server::env::read_server_env;
use spm_server::import_cli;
use spm_server::progress::Progress;
use spm_server::serve::serve_from_env;

const USAGE: &str = "usage: spm-server [import-curamanager <library-dir> <username> [--in-place]]";

fn os_env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
}

/// Every misconfiguration reaches the operator the same way: the one sentence the resolver in
/// `env.rs` wrote, naming the variable and what it wanted, then exit status 1. A sentence rather
/// than a stack trace, because the fault is in their config and not in this code, and because it
/// is printed before the logger exists: there is nowhere else for it to go.
fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "{message}");
    ExitCode::from(1)
}

fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
}

fn serve() -> ExitCode {
    let env = match read_server_env(&os_env) {
        Ok(env) => env,
        Err(error) => return fail(&error.message),
    };
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(error) => return fail(&format!("could not start the async runtime: {error}")),
    };
    let result = runtime.block_on(serve_from_env(env));
    // A preview pass that is mid-render cannot be interrupted; do not wait minutes for it.
    runtime.shutdown_timeout(Duration::from_secs(2));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => fail(&message),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => serve(),
        Some("import-curamanager") => {
            let progress = Progress::stdout();
            let code = import_cli::run(
                &args[1..],
                &os_env,
                &progress,
                &mut std::io::stdout(),
                &mut std::io::stderr(),
            );
            ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
        Some("--help" | "-h") => {
            let _ = writeln!(std::io::stdout(), "{USAGE}");
            ExitCode::SUCCESS
        }
        Some(other) => fail(&format!("unknown command: {other}\n{USAGE}")),
    }
}
