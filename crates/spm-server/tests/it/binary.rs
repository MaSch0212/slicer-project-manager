//! The `spm-server` binary as an operator meets it: environment errors, first run, restart.

use std::process::Command;

const BINARY: &str = env!("CARGO_BIN_EXE_spm-server");

/// Every variable the server reads, so a developer's own environment never leaks into a test.
const VARIABLES: [&str; 10] = [
    "SPM_LIBRARY_DIR",
    "SPM_PORT",
    "SPM_WEB_ROOT",
    "SPM_PUBLIC_ORIGIN",
    "SPM_LOG_LEVEL",
    "SPM_DEV_UI_ORIGIN",
    "SPM_PREVIEW_INTERVAL_MS",
    "SPM_PREVIEW_CONCURRENCY",
    "SPM_MAX_MESH_MB",
    "SPM_MAX_STEP_MB",
];

fn command(args: &[&str], env: &[(&str, &str)]) -> Command {
    let mut command = Command::new(BINARY);
    command.args(args);
    for variable in VARIABLES {
        command.env_remove(variable);
    }
    command.envs(env.iter().copied());
    command
}

struct Finished {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_to_end(args: &[&str], env: &[(&str, &str)]) -> Finished {
    let output = command(args, env).output().expect("the binary runs");
    Finished {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

#[test]
fn a_missing_library_dir_is_one_line_and_exit_status_1() {
    let finished = run_to_end(&[], &[]);
    assert_eq!(finished.code, Some(1));
    assert_eq!(finished.stderr, "SPM_LIBRARY_DIR is required\n");
    assert_eq!(finished.stdout, "");
}

#[test]
fn an_unusable_variable_is_one_line_naming_it_and_never_a_stack_trace() {
    let dir = tempfile::tempdir().unwrap();
    let library = dir.path().to_str().unwrap();
    for (variable, value, expected) in [
        (
            "SPM_PORT",
            "abc",
            "SPM_PORT=\"abc\" is not a TCP port. Expected a whole number from 1 to 65535\n",
        ),
        (
            "SPM_PORT",
            " 8000 ",
            "SPM_PORT=\" 8000 \" is not a TCP port. Expected a whole number from 1 to 65535\n",
        ),
        (
            "SPM_PREVIEW_CONCURRENCY",
            "65",
            "SPM_PREVIEW_CONCURRENCY=\"65\" is not a worker count. Expected a whole number from 1 to 64\n",
        ),
        (
            "SPM_MAX_MESH_MB",
            "0",
            "SPM_MAX_MESH_MB=\"0\" is not a size. Expected a whole number of megabytes from 1 to 2048\n",
        ),
        (
            "SPM_LOG_LEVEL",
            "loud",
            "SPM_LOG_LEVEL=\"loud\" is not a log level. Use one of: silent, error, warn, info, debug, trace\n",
        ),
        (
            "SPM_PUBLIC_ORIGIN",
            "print.example.com",
            "SPM_PUBLIC_ORIGIN is not a valid absolute URL: print.example.com\n",
        ),
        (
            "SPM_DEV_UI_ORIGIN",
            "ftp://localhost:5173",
            "SPM_DEV_UI_ORIGIN must be http(s): ftp://localhost:5173\n",
        ),
    ] {
        let finished = run_to_end(&[], &[("SPM_LIBRARY_DIR", library), (variable, value)]);
        assert_eq!(finished.code, Some(1), "{variable}={value:?}");
        assert_eq!(finished.stderr, expected, "{variable}={value:?}");
        assert_eq!(finished.stdout, "");
        assert!(!finished.stderr.contains("panicked"));
    }
}

#[test]
fn the_first_error_wins_and_nothing_is_created_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let library = dir.path().join("never-created");
    let finished = run_to_end(
        &[],
        &[
            ("SPM_LIBRARY_DIR", library.to_str().unwrap()),
            ("SPM_PORT", "abc"),
            ("SPM_PREVIEW_INTERVAL_MS", "also-bad"),
        ],
    );
    assert_eq!(finished.code, Some(1));
    assert!(
        finished.stderr.starts_with("SPM_PORT="),
        "{}",
        finished.stderr
    );
    assert_eq!(finished.stderr.lines().count(), 1);
    // Validated before the server touches anything: a typo must not leave a library behind.
    assert!(!library.exists());
}

#[test]
fn commands_other_than_import_are_refused_and_import_needs_its_arguments() {
    let unknown = run_to_end(&["serve"], &[]);
    assert_eq!(unknown.code, Some(1));
    assert!(
        unknown.stderr.starts_with("unknown command: serve"),
        "{}",
        unknown.stderr
    );

    let import = run_to_end(&["import-curamanager"], &[]);
    assert_eq!(import.code, Some(1));
    assert_eq!(
        import.stderr,
        "usage: spm-server import-curamanager <library-dir> <username> [--in-place]\n"
    );

    let help = run_to_end(&["--help"], &[]);
    assert_eq!(help.code, Some(0));
    assert!(help.stdout.starts_with("usage: spm-server"));
}

#[test]
fn a_library_that_cannot_be_opened_is_one_line_and_exit_status_1() {
    let dir = tempfile::tempdir().unwrap();
    // A file where the library directory should be.
    let file = dir.path().join("not-a-directory");
    std::fs::write(&file, "x").unwrap();
    let finished = run_to_end(
        &[],
        &[
            ("SPM_LIBRARY_DIR", file.to_str().unwrap()),
            ("SPM_LOG_LEVEL", "silent"),
        ],
    );
    assert_eq!(finished.code, Some(1));
    assert!(
        finished
            .stderr
            .starts_with("could not open the library at "),
        "{}",
        finished.stderr
    );
    assert_eq!(finished.stderr.lines().count(), 1);
}

/// The part of the suite that has a child process *listening*: it binds all interfaces (the
/// production default), which on a developer's Windows machine raises a firewall prompt for every
/// freshly built test binary. So it only compiles where that does not matter. The same startup
/// sequence runs on loopback in `serve.rs`.
#[cfg(unix)]
mod listening {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;
    use std::process::{Child, Stdio};
    use std::sync::mpsc::{self, Receiver};
    use std::thread;
    use std::time::{Duration, Instant};

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// A running server. Killed when dropped.
    struct Server {
        child: Child,
        lines: Receiver<String>,
        seen: Vec<String>,
        port: u16,
    }

    impl Server {
        fn start(library: &Path, extra: &[(&str, &str)]) -> Server {
            let port = free_port();
            let (port_text, library_text) =
                (port.to_string(), library.to_string_lossy().into_owned());
            let mut env = vec![
                ("SPM_LIBRARY_DIR", library_text.as_str()),
                ("SPM_PORT", port_text.as_str()),
            ];
            env.extend_from_slice(extra);
            let mut child = command(&[], &env)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("the binary starts");
            let (sender, lines) = mpsc::channel();
            for stream in [
                Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
                Box::new(child.stderr.take().unwrap()),
            ] {
                let sender = sender.clone();
                thread::spawn(move || {
                    for line in BufReader::new(stream).lines().map_while(Result::ok) {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                });
            }
            Server {
                child,
                lines,
                seen: Vec::new(),
                port,
            }
        }

        /// Waits for an output line containing `needle` and returns it.
        fn wait_for(&mut self, needle: &str) -> String {
            if let Some(line) = self.seen.iter().find(|line| line.contains(needle)) {
                return line.clone();
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match self.lines.recv_timeout(left) {
                    Ok(line) => {
                        self.seen.push(line.clone());
                        if line.contains(needle) {
                            return line;
                        }
                    }
                    Err(_) => break,
                }
            }
            panic!("no line containing {needle:?}; saw {:#?}", self.seen);
        }

        /// Every line printed so far, after giving the process a moment to print what it is about to.
        fn drain(&mut self) -> Vec<String> {
            thread::sleep(Duration::from_millis(300));
            while let Ok(line) = self.lines.try_recv() {
                self.seen.push(line);
            }
            self.seen.clone()
        }

        fn get(&self, path: &str) -> (u16, String) {
            let mut stream =
                TcpStream::connect(("127.0.0.1", self.port)).expect("the server accepts");
            write!(
                stream,
                "GET {path} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
                self.port
            )
            .unwrap();
            let mut raw = String::new();
            stream.read_to_string(&mut raw).unwrap();
            let status = raw.split_whitespace().nth(1).unwrap().parse().unwrap();
            let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
            (status, body.to_owned())
        }

        fn stop(mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn sigterm_shuts_the_server_down_cleanly() {
        // What `docker stop` sends. Not exercised on Windows, which has no SIGTERM to send.
        let dir = tempfile::tempdir().unwrap();
        let mut server = Server::start(dir.path(), &[]);
        server.wait_for("listening");
        let status = Command::new("kill")
            .args(["-TERM", &server.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        let deadline = Instant::now() + Duration::from_secs(10);
        let exit = loop {
            if let Some(exit) = server.child.try_wait().unwrap() {
                break exit;
            }
            assert!(Instant::now() < deadline, "the server ignored SIGTERM");
            thread::sleep(Duration::from_millis(50));
        };
        assert!(exit.success(), "{exit:?}");
        server.wait_for("shutting down");
    }
}
