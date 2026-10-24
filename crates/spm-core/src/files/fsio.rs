//! Positional reads, so no reader's progress depends on a shared file cursor.
//!
//! `&File` can be read from by several owners at once (an open zip and every entry stream taken
//! from it), and a cursor-based read would let one of them move the others. Reading at an explicit
//! offset makes each read independent of every other.

use std::fs::File;
use std::io;

#[cfg(unix)]
pub(crate) fn read_at(file: &File, buf: &mut [u8], position: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, position)
}

#[cfg(windows)]
pub(crate) fn read_at(file: &File, buf: &mut [u8], position: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, position)
}

/// Fills `buf` from `position`, or fails with `UnexpectedEof` when the file ends first.
pub(crate) fn read_exact_at(file: &File, buf: &mut [u8], position: u64) -> io::Result<()> {
    let mut read = 0;
    while read < buf.len() {
        match read_at(file, &mut buf[read..], position + read as u64) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => read += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
