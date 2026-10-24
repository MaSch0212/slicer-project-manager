//! The chunk plumbing in `files/chunks.rs`. The legacy tests for it live in `mesh-streaming.test.ts`
//! (they test the module this part ports, ahead of the parsers that use it), so they are ported
//! here: the line sink, `read_file_chunks`, `OpenFile`, and `drain_sink` against `feed_sink`.

use std::fs;

use spm_core::AppErrorCode;
use spm_core::files::chunks::{
    ChunkSink, ChunkSource, MAX_LINE_CHARS, OpenFile, drain_sink, feed_sink, make_line_sink,
    read_file_chunks,
};
use tempfile::tempdir;

#[test]
fn a_line_split_across_chunks_is_rejoined_and_a_multi_byte_character_across_chunks_survives() {
    // The line sink's whole contract in one assertion. Fed byte by byte, every line boundary and
    // every one of the emoji's four bytes lands on a chunk boundary.
    let text = "alpha\nbeta \u{1F600} gamma\r\n\nlast";
    let bytes = text.as_bytes();

    let mut one_chunk: Vec<String> = Vec::new();
    feed_sink(
        make_line_sink(|line| one_chunk.push(line.to_owned())),
        bytes,
    )
    .unwrap();

    let mut byte_at_a_time: Vec<String> = Vec::new();
    let mut sink = make_line_sink(|line| byte_at_a_time.push(line.to_owned()));
    for i in 0..bytes.len() {
        sink.push(&bytes[i..=i]).unwrap();
    }
    sink.end().unwrap();

    assert_eq!(one_chunk, ["alpha", "beta \u{1F600} gamma\r", "", "last"]);
    assert_eq!(byte_at_a_time, one_chunk);
}

#[test]
fn a_file_with_no_newline_at_all_is_refused_rather_than_buffered_whole() {
    // Without the cap the sink's carry-over is the file, which is exactly the failure the sink
    // exists to remove. Two megabytes of `a` is well past it.
    let mut sink = make_line_sink(|_| {});
    let error = sink.push("a".repeat(2_000_000).as_bytes()).unwrap_err();
    assert_eq!(error.code, AppErrorCode::Validation);
    const { assert!(MAX_LINE_CHARS < 2_000_000) };
}

#[test]
fn read_file_chunks_yields_the_file_in_order_and_reuses_one_buffer() {
    let dir = tempdir().unwrap();
    let bytes: Vec<u8> = (0..5000u32).map(|i| (i & 0xff) as u8).collect();
    let path = dir.path().join("bytes.bin");
    fs::write(&path, &bytes).unwrap();

    let mut joined = Vec::new();
    let mut pieces = 0;
    let mut addresses = Vec::new();
    let mut chunks = read_file_chunks(&path, 1024).unwrap();
    while let Some(chunk) = chunks.pull_chunk().unwrap() {
        joined.extend_from_slice(chunk);
        addresses.push(chunk.as_ptr());
        pieces += 1;
    }
    assert_eq!(joined, bytes);
    assert_eq!(pieces, 5); // 4 full 1024-byte chunks and a 904-byte tail
    assert!(
        addresses.windows(2).all(|pair| pair[0] == pair[1]),
        "every chunk should be a view into the same reused buffer"
    );
}

/// The legacy test pulled a chunk after `close()` and required a failure instead of a read of
/// whatever file had taken the recycled descriptor. In Rust the stream shares ownership of the
/// file, so the descriptor cannot be closed (let alone recycled) underneath it: what has to hold
/// instead is that a chunk stream keeps working after the `OpenFile` that made it is dropped, and
/// that every pull reads the file it was opened on.
#[test]
fn an_open_file_stream_outlives_its_holder_and_never_reads_another_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("closed.bin");
    fs::write(&path, vec![7u8; 4096]).unwrap();
    let file = OpenFile::open(&path).unwrap();
    assert_eq!(file.size(), 4096);
    let mut chunks = file.chunks(64);
    assert_eq!(chunks.pull_chunk().unwrap().unwrap().len(), 64);
    drop(file);

    // A decoy that would receive a recycled descriptor on a platform that recycles them.
    let decoy = dir.path().join("decoy.bin");
    fs::write(&decoy, vec![0x44u8; 4096]).unwrap();
    let _decoy = fs::File::open(&decoy).unwrap();

    let mut rest = Vec::new();
    while let Some(chunk) = chunks.pull_chunk().unwrap() {
        rest.extend_from_slice(chunk);
    }
    assert_eq!(rest.len(), 4096 - 64);
    assert!(rest.iter().all(|&byte| byte == 7));
}

#[test]
fn open_file_head_returns_the_first_bytes_or_the_whole_short_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("short.bin");
    fs::write(&path, b"0123456789").unwrap();
    let file = OpenFile::open(&path).unwrap();
    assert_eq!(file.head(4).unwrap(), b"0123");
    assert_eq!(file.head(100).unwrap(), b"0123456789");
}

#[test]
fn drain_sink_and_feed_sink_agree_on_the_same_bytes() {
    let dir = tempdir().unwrap();
    let text = (0..5000)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let path = dir.path().join("lines.txt");
    fs::write(&path, &text).unwrap();

    let mut streamed: Vec<String> = Vec::new();
    drain_sink(
        make_line_sink(|line| streamed.push(line.to_owned())),
        read_file_chunks(&path, 97).unwrap(),
    )
    .unwrap();
    let mut buffered: Vec<String> = Vec::new();
    feed_sink(
        make_line_sink(|line| buffered.push(line.to_owned())),
        text.as_bytes(),
    )
    .unwrap();
    assert_eq!(streamed, buffered);
    assert_eq!(streamed.len(), 5000);
}
