//! Finding the slicers that are installed, in one subprocess.
//!
//! There is no registry API and no MSIX API in the standard library, and the measured mechanism
//! (D decision 5) already covers both halves in one document: **one** `powershell -NoProfile
//! -NonInteractive -EncodedCommand` child process emitting a single JSON document. One process
//! because `Get-AppxPackage` forces PowerShell anyway and one subprocess is one failure mode, one
//! timeout and one parse to test. Measured: 880 ms for 222 uninstall keys and 43 KB of JSON.
//!
//! **On demand, never at app start**, and a stale path is caught by a `stat` before every spawn
//! regardless ([`crate::slicers::config::resolve_install_path`]).
//!
//! **The subprocess is injected** ([`RunDetection`]) so everything below the process boundary runs
//! under plain `cargo test` with no PowerShell and no Windows.
//!
//! **The document is untrusted input.** It names paths this app will later execute. Nothing
//! reaches [`DetectedInstall`] that has not been checked absolute, existing, a regular file and,
//! for the two automatic origins, named exactly like the registry row's `exe_name`.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use spm_core::dto::SlicerId;

use super::registry::{SLICER_IDS, slicer, slicer_for_display_name};
use super::winpath;

/// Where an install came from, and the key that identifies it across updates (spec 4.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InstallOrigin {
    /// `hive` (`HKLM`, `HKLM\WOW6432Node` or `HKCU`) and the uninstall subkey name: the key alone
    /// is not unique across hives.
    Registry {
        hive: String,
        key: String,
    },
    Msix {
        #[serde(rename = "packageFamily")]
        package_family: String,
    },
    Manual {
        id: String,
    },
}

impl InstallOrigin {
    /// The wire spelling of the kind.
    pub fn kind_str(&self) -> &'static str {
        match self {
            InstallOrigin::Registry { .. } => "registry",
            InstallOrigin::Msix { .. } => "msix",
            InstallOrigin::Manual { .. } => "manual",
        }
    }
}

/// An install detection is prepared to vouch for: it exists, and it is the right executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedInstall {
    /// `registry:<hive>:<key>` or `msix:<packageFamily>`: the origin key, never the path.
    pub id: String,
    pub slicer_id: SlicerId,
    pub label: String,
    pub origin: InstallOrigin,
    pub version: Option<String>,
    pub path: String,
}

/// The injected subprocess: run it, get the JSON text back (or why it could not run).
pub type RunDetection = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

/// The one filesystem question the parse asks, injected so a fixture needs no real executables.
pub trait DetectIo: Send + Sync {
    fn is_regular_file(&self, path: &str) -> bool;
}

impl<F: Fn(&str) -> bool + Send + Sync> DetectIo for F {
    fn is_regular_file(&self, path: &str) -> bool {
        self(path)
    }
}

/// The real filesystem.
pub struct FsDetectIo;

/// Whether `path` is a regular file that exists: the predicate `add_manual` and the pre-launch
/// check make, and the one the parse asks.
pub fn is_regular_file(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

impl DetectIo for FsDetectIo {
    fn is_regular_file(&self, path: &str) -> bool {
        is_regular_file(path)
    }
}

/// The three hives, spelled the way `Get-ItemProperty` wants them. **All three, and
/// `WOW6432Node` is not optional**: Cura registers there despite being 64-bit, so a detector that
/// reads the two obvious hives misses both Curas.
const UNINSTALL_HIVES: [(&str, &str); 3] = [
    (
        "HKLM",
        "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    ),
    (
        "HKLM\\WOW6432Node",
        "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    ),
    (
        "HKCU",
        "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
    ),
];

/// Nothing may be interpolated into the script that is not one of these characters: letters,
/// digits, `.`, `_`, `\`, `:`, `*` and `-`. That excludes `'` (which would close a literal), `"`,
/// `$`, backtick, `;`, parentheses, braces, `|`, `&`, newlines and spaces.
///
/// Exported so it can be driven: both of its operands are module constants, so nothing a test
/// could pass to [`detection_script`] reaches the refusal.
pub fn is_safe_script_literal(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '\\' | ':' | '*' | '-'))
}

/// The PowerShell that produces the detection document. Handed to the process as
/// `-EncodedCommand`, so nothing about its punctuation matters.
///
/// Each note is a real behaviour of Windows PowerShell 5.1: `$ErrorActionPreference =
/// 'SilentlyContinue'` so an unreadable key produces a shorter document rather than none; the
/// `$null` guard inside each loop is load-bearing (`foreach ($x in $null)` iterates once in 5.1);
/// arrays are built by `+=` because a one-element pipeline result is not an array; and
/// `ConvertTo-Json` escapes every non-ASCII character so the pipe carries pure ASCII.
pub fn detection_script() -> String {
    let families: Vec<&str> = SLICER_IDS
        .iter()
        .filter_map(|id| slicer(*id).windows.msix_package_family)
        .collect();
    let literals = families.iter().copied().chain(
        UNINSTALL_HIVES
            .iter()
            .flat_map(|(hive, path)| [*hive, *path]),
    );
    for literal in literals {
        assert!(
            is_safe_script_literal(literal),
            "refusing to build a detection script around {literal:?}"
        );
    }
    let hives = UNINSTALL_HIVES
        .iter()
        .map(|(hive, path)| format!("@('{hive}', '{path}')"))
        .collect::<Vec<_>>()
        .join(", ");
    let family_list = families
        .iter()
        .map(|family| format!("'{family}'"))
        .collect::<Vec<_>>()
        .join(", ");
    [
        "$ErrorActionPreference = 'SilentlyContinue'".to_owned(),
        "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false".to_owned(),
        "$registry = @()".to_owned(),
        format!("foreach ($h in @({hives})) {{"),
        "  foreach ($item in Get-ItemProperty -Path $h[1]) {".to_owned(),
        "    if ($null -eq $item.DisplayName) { continue }".to_owned(),
        "    $registry += [pscustomobject]@{ hive = $h[0]; key = [string]$item.PSChildName; displayName = [string]$item.DisplayName; displayVersion = [string]$item.DisplayVersion; displayIcon = [string]$item.DisplayIcon }".to_owned(),
        "  }".to_owned(),
        "}".to_owned(),
        "$msix = @()".to_owned(),
        format!("foreach ($family in @({family_list})) {{"),
        // A package family is `<name>_<publisher hash>` and `Get-AppxPackage -Name` wants the name
        // half. `LastIndexOf` answers -1 for a family with no underscore, and `Substring(0, -1)` is
        // a PowerShell exception that would take the registry half down with it.
        "  $cut = $family.LastIndexOf('_')".to_owned(),
        "  if ($cut -lt 1) { continue }".to_owned(),
        "  foreach ($pkg in Get-AppxPackage -Name $family.Substring(0, $cut)) {".to_owned(),
        "    if ($pkg.PackageFamilyName -ne $family) { continue }".to_owned(),
        "    $msix += [pscustomobject]@{ packageFamily = [string]$pkg.PackageFamilyName; packageFullName = [string]$pkg.PackageFullName; version = [string]$pkg.Version; installLocation = [string]$pkg.InstallLocation }".to_owned(),
        "  }".to_owned(),
        "}".to_owned(),
        "[pscustomobject]@{ registry = @($registry); msix = @($msix) } | ConvertTo-Json -Depth 4 -Compress".to_owned(),
    ]
    .join("\n")
}

/// 20 s, and the process is killed when it expires.
pub const DETECTION_TIMEOUT: Duration = Duration::from_secs(20);

/// The most output a detection run may produce before it is a failure (measured: 43 KB).
pub const DETECTION_MAX_OUTPUT: usize = 32 * 1024 * 1024;

/// The script as `-EncodedCommand` takes it: UTF-16LE, base64. This is what removes the quoting
/// question rather than answering it.
pub fn encoded_detection_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

/// `powershell.exe` by absolute path, not by PATH search: `%SystemRoot%`, with `C:\Windows` only
/// for an environment that has unset it. Windows PowerShell 5.1 specifically (in-box on every
/// supported Windows, with `Get-AppxPackage`), not `pwsh`.
pub fn power_shell_path(env: &dyn Fn(&str) -> Option<String>) -> String {
    let root = env("SystemRoot")
        .or_else(|| env("windir"))
        .unwrap_or_else(|| "C:\\Windows".to_owned());
    winpath::join(
        &winpath::join(&winpath::join(&root, "System32"), "WindowsPowerShell\\v1.0"),
        "powershell.exe",
    )
}

/// What a real run does, as a function of the arguments. Split out so the console-window flag and
/// the timeout can be exercised against a harmless program.
pub fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
    max_output: usize,
) -> Result<String, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start the detection process: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("the detection process has no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => return Ok(out),
                Ok(n) => {
                    out.extend_from_slice(&chunk[..n]);
                    if out.len() > max_output {
                        return Err("the detection output was larger than allowed".to_owned());
                    }
                }
                Err(error) => return Err(format!("could not read the detection output: {error}")),
            }
        }
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return Err(format!("could not wait for the detection process: {error}"));
            }
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(format!(
                "the detection process did not finish in {} s",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let output = reader
        .join()
        .map_err(|_| "the detection reader panicked".to_owned())??;
    if !status.success() {
        return Err(format!("the detection process exited with {status}"));
    }
    String::from_utf8(output).map_err(|_| "the detection output was not UTF-8".to_owned())
}

/// **A console window flashes on the user's screen without this**, for the 880 ms the scan takes:
/// the shell is a GUI-subsystem binary, so a console child gets a window of its own unless
/// `CREATE_NO_WINDOW` is passed. Windows only.
#[cfg(windows)]
pub fn no_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn no_console_window(_command: &mut Command) {}

/// Runs the script in a real PowerShell and answers with its stdout. Every failure (a timeout, a
/// `powershell.exe` that is not there, an overflowed buffer) is an `Err`.
pub fn run_powershell_detection() -> Result<String, String> {
    let mut command = Command::new(power_shell_path(&|name| std::env::var(name).ok()));
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &encoded_detection_command(&detection_script()),
    ]);
    run_with_timeout(command, DETECTION_TIMEOUT, DETECTION_MAX_OUTPUT)
}

/// The real subprocess as a [`RunDetection`].
pub fn powershell_runner() -> RunDetection {
    Arc::new(run_powershell_detection)
}

/// Registry string values are not guaranteed to be what they look like: one `DisplayName` on the
/// measured machine reads `Fork\0\0\0…`. **Every NUL is removed, wherever it is.** What that
/// permissiveness cannot reach is a spawn: a path only becomes an install after
/// [`validated_executable`].
fn clean(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| text.replace('\0', "").trim().to_owned())
        .unwrap_or_default()
}

/// The executable a `DisplayIcon` names, or `None`. Documented as `path[,index]` and may be
/// quoted. The index is cut from the *end* only, and only when what follows the last comma is an
/// optionally negative run of digits: a path may legitimately contain a comma.
pub fn executable_from_display_icon(display_icon: &str) -> Option<String> {
    let mut text = clean(Some(&Value::String(display_icon.to_owned())));
    if let Some(comma) = text.rfind(',') {
        let tail = text[comma + 1..].trim();
        let digits = tail.strip_prefix('-').unwrap_or(tail);
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            text = text[..comma].trim().to_owned();
        }
    }
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        text = text[1..text.len() - 1].to_owned();
    }
    (!text.is_empty()).then_some(text)
}

/// Whether a path is one this app is prepared to hand to `spawn`: absolute, **named exactly like
/// the registry row's `exe_name`** (case-insensitively: NTFS is), and an existing regular file.
/// `win32` semantics regardless of the host, because the document describes a Windows machine.
fn validated_executable(path: &str, exe_name: &str, io: &dyn DetectIo) -> Option<String> {
    if !winpath::is_absolute(path) {
        return None;
    }
    if !winpath::basename(path).eq_ignore_ascii_case(exe_name) {
        return None;
    }
    if !io.is_regular_file(path) {
        return None;
    }
    Some(path.to_owned())
}

fn rows_of<'a>(document: &'a Value, key: &str) -> &'a [Value] {
    document
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn field(row: &Value, name: &str) -> String {
    clean(row.as_object().and_then(|object| object.get(name)))
}

/// Turns the subprocess's JSON into the installs the app will offer, discarding everything it
/// cannot vouch for. A row that does not check out is not reported rather than failing the scan
/// over one malformed key on a machine with two hundred. What is *not* silent is unparseable JSON
/// (the subprocess did not do what it was asked), which is one `warn`.
///
/// **Versions come from `DisplayVersion` or the MSIX package, never from the executable**: Cura's
/// and Orca's version resources are empty.
pub fn parse_detection_with(
    json: &str,
    io: &dyn DetectIo,
    warn: &mut dyn FnMut(&str),
) -> Vec<DetectedInstall> {
    let document: Value = match serde_json::from_str(json) {
        Ok(document) => document,
        Err(error) => {
            warn(&format!(
                "the slicer detection subprocess did not return JSON: {error}"
            ));
            return Vec::new();
        }
    };
    let mut installs = Vec::new();

    for row in rows_of(&document, "registry") {
        let display_name = field(row, "displayName");
        let Some(slicer_id) = slicer_for_display_name(&display_name) else {
            continue;
        };
        let Some(icon) = executable_from_display_icon(&field(row, "displayIcon")) else {
            continue;
        };
        let Some(path) = validated_executable(&icon, slicer(slicer_id).windows.exe_name, io) else {
            continue;
        };
        let hive = field(row, "hive");
        let key = field(row, "key");
        if hive.is_empty() || key.is_empty() {
            continue;
        }
        let version = field(row, "displayVersion");
        installs.push(DetectedInstall {
            id: format!("registry:{hive}:{key}"),
            slicer_id,
            // The vendor's own words, which carry the version for three of the five.
            label: display_name,
            origin: InstallOrigin::Registry { hive, key },
            version: (!version.is_empty()).then_some(version),
            path,
        });
    }

    for row in rows_of(&document, "msix") {
        let package_family = field(row, "packageFamily");
        let slicer_id = SLICER_IDS
            .into_iter()
            .find(|id| slicer(*id).windows.msix_package_family == Some(package_family.as_str()));
        let Some(slicer_id) = slicer_id.filter(|_| !package_family.is_empty()) else {
            continue;
        };
        let location = field(row, "installLocation");
        if location.is_empty() {
            continue;
        }
        let exe_name = slicer(slicer_id).windows.exe_name;
        let Some(path) = validated_executable(&winpath::join(&location, exe_name), exe_name, io)
        else {
            continue;
        };
        let version = field(row, "version");
        installs.push(DetectedInstall {
            id: format!("msix:{package_family}"),
            slicer_id,
            label: slicer(slicer_id).display_name.to_owned(),
            origin: InstallOrigin::Msix { package_family },
            version: (!version.is_empty()).then_some(version),
            path,
        });
    }

    // Two uninstall keys can name the same executable, and the id is what identifies an install,
    // so a duplicate id is one install seen twice. First wins, in hive order.
    let mut seen = std::collections::HashSet::new();
    installs.retain(|install| seen.insert(install.id.clone()));
    installs
}

/// [`parse_detection_with`], warning to stderr.
pub fn parse_detection(json: &str, io: &dyn DetectIo) -> Vec<DetectedInstall> {
    parse_detection_with(json, io, &mut crate::diag::warn)
}

/// Detection, end to end: run the subprocess, parse what it said. Off Windows this is not called
/// at all (see `SlicersHost`): nothing about macOS or Linux detection is designed here.
pub fn detect_installs(
    run: &RunDetection,
    io: &dyn DetectIo,
    warn: &mut dyn FnMut(&str),
) -> Result<Vec<DetectedInstall>, String> {
    Ok(parse_detection_with(&run()?, io, warn))
}
