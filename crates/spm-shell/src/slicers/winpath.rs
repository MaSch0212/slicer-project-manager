//! Windows path rules, on any host.
//!
//! Detection documents describe a Windows machine by construction, and the tests run on whatever
//! host the build runs on, so these follow Node's `path.win32` (what the legacy code used) instead
//! of the host's `std::path`.

/// `win32.isAbsolute`: rooted (`\x`, `/x`) or a drive followed by a separator (`C:\x`). A
/// drive-relative `C:x` is **not** absolute: it means "the current directory on C:".
pub fn is_absolute(path: &str) -> bool {
    let mut chars = path.chars();
    match chars.next() {
        Some('\\' | '/') => true,
        Some(drive) if drive.is_ascii_alphabetic() => {
            chars.next() == Some(':') && matches!(chars.next(), Some('\\' | '/'))
        }
        _ => false,
    }
}

/// `win32.basename`: the last segment, ignoring trailing separators and a leading drive.
pub fn basename(path: &str) -> &str {
    let mut rest = path;
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        rest = &rest[2..];
    }
    let trimmed = rest.trim_end_matches(['\\', '/']);
    trimmed.rsplit(['\\', '/']).next().unwrap_or("")
}

/// `win32.join` for one directory and one name.
pub fn join(directory: &str, name: &str) -> String {
    let directory = directory.trim_end_matches(['\\', '/']);
    format!("{directory}\\{name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_means_rooted_or_drive_and_separator() {
        assert!(is_absolute("C:\\Program Files\\x.exe"));
        assert!(is_absolute("c:/x"));
        assert!(is_absolute("\\\\server\\share\\x.exe"));
        assert!(!is_absolute("x.exe"));
        assert!(!is_absolute(".\\x.exe"));
        assert!(!is_absolute("..\\x.exe"));
        assert!(!is_absolute("C:x.exe"));
        assert!(!is_absolute("Program Files\\x.exe"));
        assert!(!is_absolute(""));
    }

    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(basename("C:\\a\\b\\Orca-Slicer.exe"), "Orca-Slicer.exe");
        assert_eq!(basename("C:/a/b.exe"), "b.exe");
        assert_eq!(basename("C:b.exe"), "b.exe");
        assert_eq!(basename("C:\\a\\b\\"), "b");
        assert_eq!(basename("plain"), "plain");
    }

    #[test]
    fn join_does_not_double_a_separator() {
        assert_eq!(join("C:\\x\\", "y.exe"), "C:\\x\\y.exe");
        assert_eq!(join("C:\\x", "y.exe"), "C:\\x\\y.exe");
    }
}
