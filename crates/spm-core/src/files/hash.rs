//! SHA-256 of a file's bytes.

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::Result;

const READ_BYTES: usize = 256 * 1024;

/// The 32-byte SHA-256 digest of the file at `path`, streamed so a multi-hundred-megabyte model
/// is never held in memory.
pub fn file_content_hash(path: &Path) -> Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_BYTES];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buffer[..n]),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(hasher.finalize().into())
}
