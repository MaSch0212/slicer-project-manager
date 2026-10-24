//! Regenerates `packages/web/src/api/generated/` from the Rust contract. Run it with
//! `pnpm gen:types` after changing a DTO; the test `generated_typescript_is_up_to_date` fails until
//! you do.

use std::process::ExitCode;

fn main() -> ExitCode {
    let dir = spm_core::tsgen::generated_dir();
    match spm_core::tsgen::write_to(&dir) {
        Ok(()) => {
            println!("wrote {}", dir.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("could not write {}: {error}", dir.display());
            ExitCode::FAILURE
        }
    }
}
