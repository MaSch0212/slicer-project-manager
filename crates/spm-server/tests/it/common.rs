//! Shared helpers: a server running on a loopback port, and a tiny HTTP client to talk to it.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use spm_core::log::LogLevelSetting;
use spm_core::{Library, Logger, OpenOptions};
use spm_server::env::{DEFAULT_MAX_MESH_MB, ServerEnv};
use spm_server::serve;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// A server environment pointing at `dir`, with every optional setting at its default and the
/// preview queue running every `interval_ms`.
pub fn env_for(dir: &Path, interval_ms: u64) -> ServerEnv {
    ServerEnv {
        library_dir: dir.to_string_lossy().into_owned(),
        level: LogLevelSetting::Silent,
        port: 8000,
        preview_interval_ms: interval_ms,
        preview_concurrency: 1,
        max_mesh_bytes: DEFAULT_MAX_MESH_MB * 1_000_000,
        dev_ui_origin: None,
        public_origin: None,
        web_root: None,
    }
}

pub fn open(dir: &Path, logger: Option<Logger>) -> Library {
    Library::open(
        dir,
        OpenOptions {
            logger,
            ..OpenOptions::default()
        },
    )
    .expect("a library opens")
}

pub struct Running {
    pub addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    handle: JoinHandle<std::io::Result<()>>,
}

impl Running {
    /// Asks the server to shut down and waits for it to drain.
    pub async fn stop(mut self) {
        let _ = self.stop.take().expect("stopped once").send(());
        tokio::time::timeout(Duration::from_secs(10), self.handle)
            .await
            .expect("the server shuts down promptly")
            .expect("the server task does not panic")
            .expect("the server stops cleanly");
    }
}

/// Serves `lib` on a loopback port with `serve::run`, exactly as `spm-server` does.
pub async fn start(lib: Library, env: &ServerEnv) -> Running {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let env = env.clone();
    let handle = tokio::spawn(async move {
        serve::run(lib, &env, Logger::noop(), listener, async {
            let _ = stopped.await;
        })
        .await
    });
    Running {
        addr,
        stop: Some(stop),
        handle,
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|error| {
            panic!("not JSON ({error}): {}", self.text());
        })
    }
}

/// One HTTP/1.1 request on its own connection, read to the end.
pub async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Response {
    let mut stream = TcpStream::connect(addr).await.expect("the server accepts");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();

    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("a complete response");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect::<Vec<_>>();
    let mut body = raw[split + 4..].to_vec();
    if headers
        .iter()
        .any(|(name, value)| name.eq_ignore_ascii_case("transfer-encoding") && value == "chunked")
    {
        body = dechunk(&body);
    }
    Response {
        status,
        headers,
        body,
    }
}

fn dechunk(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") else {
            return out;
        };
        let size = usize::from_str_radix(
            std::str::from_utf8(&body[..line_end]).unwrap_or("0").trim(),
            16,
        )
        .unwrap_or(0);
        if size == 0 {
            return out;
        }
        let start = line_end + 2;
        out.extend_from_slice(&body[start..start + size]);
        body = &body[start + size + 2..];
    }
}

/// A binary STL cube: 12 triangles, enough for the rasterizer to have something to draw.
pub fn cube_stl() -> Vec<u8> {
    const CORNERS: [[f32; 3]; 8] = [
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
    ];
    const FACES: [[usize; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [2, 3, 7],
        [2, 7, 6],
        [1, 2, 6],
        [1, 6, 5],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut out = vec![0u8; 80];
    out.extend((FACES.len() as u32).to_le_bytes());
    for face in FACES {
        out.extend([0u8; 12]);
        for corner in face {
            for value in CORNERS[corner] {
                out.extend(value.to_le_bytes());
            }
        }
        out.extend([0u8; 2]);
    }
    out
}

/// The repository root, found from this crate's manifest directory.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
