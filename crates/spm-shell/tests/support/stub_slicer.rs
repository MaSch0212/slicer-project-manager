// A stand-in for a slicer, and the only thing the tests ever start as one.
//
// **It opens no window and does nothing but write down what it was started with.** It is compiled
// on demand by the test that needs it (support/stub.rs) into that test's temporary directory, so no
// real slicer is ever started and nothing here is a shipped binary.
//
// What it records, next to itself as `<exe>.record.json`: its argv, its working directory, every
// environment variable it inherited, its process id, and whether its stdin was already at end of
// file (a detached child has no console input).
//
// How long it lives is read from `<exe>.mode` beside it: absent or `exit` means "write the record
// and exit at once"; `sleep=<milliseconds>` means "write the record and stay alive that long", so a
// test can observe a slicer that is still running.

use std::io::Read;

fn escape(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn main() {
    let exe = std::env::current_exe().expect("a current exe");
    let sidecar = |suffix: &str| {
        let mut name = exe.as_os_str().to_owned();
        name.push(suffix);
        std::path::PathBuf::from(name)
    };

    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().map(|dir| dir.display().to_string()).unwrap_or_default();
    let mut stdin_bytes = Vec::new();
    let stdin_eof = std::io::stdin().read_to_end(&mut stdin_bytes).map(|n| n == 0).unwrap_or(true);

    let args_json = args
        .iter()
        .map(|arg| format!("\"{}\"", escape(arg)))
        .collect::<Vec<_>>()
        .join(",");
    let env_json = std::env::vars()
        .map(|(name, value)| format!("\"{}\":\"{}\"", escape(&name), escape(&value)))
        .collect::<Vec<_>>()
        .join(",");
    let record = format!(
        "{{\"args\":[{args_json}],\"cwd\":\"{}\",\"pid\":{},\"stdinEof\":{stdin_eof},\"env\":{{{env_json}}}}}",
        escape(&cwd),
        std::process::id()
    );
    // Written whole and renamed into place, so a test that polls for the file never reads half.
    let temp = sidecar(".record.tmp");
    std::fs::write(&temp, record).expect("the record is written");
    std::fs::rename(&temp, sidecar(".record.json")).expect("the record is in place");

    let mode = std::fs::read_to_string(sidecar(".mode")).unwrap_or_default();
    if let Some(ms) = mode.trim().strip_prefix("sleep=").and_then(|ms| ms.parse::<u64>().ok()) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}
