//! Ported from `browse-last-page.test.ts` and `browse-notices.test.ts`: the one remembered page and
//! the out-of-band notices.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use spm_core::dto::{BrowseNoticeDto, BrowseNoticeKind};
use spm_shell::browse::last_page::{
    BROWSE_FILE_NAME, LAST_URL_KEY, MAX_REMEMBERED_URL, clear_last_page, is_rememberable_url,
    read_last_page, write_last_page, write_last_page_with,
};
use spm_shell::browse::notices::{BrowseNotices, MAX_NOTICE_TEXT, MAX_NOTICES};
use spm_shell::json_store::{FsIo, JsonStoreIo};

fn file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(BROWSE_FILE_NAME);
    (dir, file)
}

// ---- last page ---------------------------------------------------------------------------------

#[test]
fn only_an_http_url_of_a_sane_length_is_a_page_this_file_will_remember() {
    let at_bound = format!(
        "https://example.com/{}",
        "a".repeat(MAX_REMEMBERED_URL - 20)
    );
    assert_eq!(at_bound.len(), MAX_REMEMBERED_URL);
    for accepted in [
        "https://www.thingiverse.com/thing:1",
        "http://example.com/",
        at_bound.as_str(),
    ] {
        assert!(is_rememberable_url(accepted), "{accepted}");
    }
    let too_long = format!("{at_bound}a");
    for refused in [
        "blob:https://www.thingiverse.com/ae5e",
        "about:blank",
        "data:text/html,x",
        "file:///C:/x",
        "spm://app/",
        "javascript:alert(1)",
        "",
        too_long.as_str(),
    ] {
        assert!(!is_rememberable_url(refused), "{refused}");
    }
}

#[test]
fn a_page_written_is_the_page_read_back_and_the_file_holds_exactly_one_entry() {
    let (_dir, file) = file();
    write_last_page(&file, "https://www.thingiverse.com/thing:1");
    assert_eq!(
        read_last_page(&file).as_deref(),
        Some("https://www.thingiverse.com/thing:1")
    );
    write_last_page(&file, "https://makerworld.com/en/models/2");
    assert_eq!(
        read_last_page(&file).as_deref(),
        Some("https://makerworld.com/en/models/2")
    );
    let on_disk: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(on_disk.as_object().unwrap().len(), 1);
    assert!(on_disk.get(LAST_URL_KEY).is_some());
}

#[test]
fn a_url_this_file_does_not_keep_leaves_the_previous_one_alone_rather_than_clearing_it() {
    let (_dir, file) = file();
    write_last_page(&file, "https://example.com/kept");
    write_last_page(&file, "blob:https://example.com/x");
    write_last_page(&file, "about:blank");
    assert_eq!(
        read_last_page(&file).as_deref(),
        Some("https://example.com/kept")
    );
}

#[test]
fn a_file_that_is_not_what_this_reader_expects_degrades_to_a_first_run() {
    let (_dir, file) = file();
    for content in [
        "",
        "not json",
        "[]",
        "\"https://example.com/\"",
        r#"{"lastUrl": 5}"#,
        r#"{"otherKey": "https://example.com/"}"#,
        r#"{"lastUrl": "file:///C:/Windows/win.ini"}"#,
    ] {
        std::fs::write(&file, content).unwrap();
        assert_eq!(read_last_page(&file), None, "{content}");
    }
    assert_eq!(read_last_page(&file.with_file_name("missing.json")), None);
}

#[test]
fn a_directory_where_the_file_should_be_is_a_first_run_and_not_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_last_page(dir.path()), None);
}

#[test]
fn clearing_removes_the_file_and_clearing_twice_is_not_an_error() {
    let (_dir, file) = file();
    write_last_page(&file, "https://example.com/x");
    assert!(file.exists());
    clear_last_page(&file);
    assert!(!file.exists());
    clear_last_page(&file);
    assert_eq!(read_last_page(&file), None);
}

/// Records every call, and fails the rename when told to.
struct Recorder {
    calls: Mutex<Vec<String>>,
    fail_rename: bool,
    inner: FsIo,
}

impl Recorder {
    fn note(&self, call: &str) {
        self.calls.lock().unwrap().push(call.to_owned());
    }
}

impl JsonStoreIo for Recorder {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        self.note("mkdir");
        self.inner.create_dir_all(dir)
    }

    fn open(&self, path: &Path) -> io::Result<u64> {
        self.note(&format!(
            "open {}",
            path.file_name().unwrap().to_string_lossy()
        ));
        self.inner.open(path)
    }

    fn write(&self, handle: u64, data: &[u8]) -> io::Result<()> {
        self.note("write");
        self.inner.write(handle, data)
    }

    fn fsync(&self, handle: u64) -> io::Result<()> {
        self.note("fsync");
        self.inner.fsync(handle)
    }

    fn close(&self, handle: u64) -> io::Result<()> {
        self.note("close");
        self.inner.close(handle)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.note("rename");
        if self.fail_rename {
            return Err(io::Error::other("rename refused"));
        }
        self.inner.rename(from, to)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        self.note("remove");
        self.inner.remove(path)
    }
}

#[test]
fn the_last_page_goes_through_the_atomic_writer_pid_temp_fsync_then_rename() {
    let (_dir, file) = file();
    let io = Recorder {
        calls: Mutex::default(),
        fail_rename: false,
        inner: FsIo::default(),
    };
    write_last_page_with(&file, "https://example.com/x", &io);
    let calls = io.calls.lock().unwrap().clone();
    let temp = format!("open {BROWSE_FILE_NAME}.{}.tmp", std::process::id());
    assert_eq!(
        calls,
        ["mkdir", temp.as_str(), "write", "fsync", "close", "rename"]
    );
}

#[test]
fn a_rename_that_fails_takes_the_temp_file_with_it_and_does_not_fail_the_caller() {
    let (dir, file) = file();
    let io = Recorder {
        calls: Mutex::default(),
        fail_rename: true,
        inner: FsIo::default(),
    };
    write_last_page_with(&file, "https://example.com/x", &io);
    assert!(!file.exists());
    let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

// ---- notices -----------------------------------------------------------------------------------

fn notices() -> (Arc<BrowseNotices>, Arc<Mutex<Vec<BrowseNoticeDto>>>) {
    let raised = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&raised);
    let counter = Arc::new(Mutex::new(0));
    let notices = BrowseNotices::new(Arc::new(move |notice| {
        sink.lock().unwrap().push(notice.clone())
    }))
    .with_clock(Arc::new(|| 1234))
    .with_ids(Arc::new(move || {
        let mut next = counter.lock().unwrap();
        *next += 1;
        format!("n{next}")
    }));
    (Arc::new(notices), raised)
}

#[test]
fn a_notice_is_appended_and_the_notification_is_raised_for_it() {
    let (notices, raised) = notices();
    let added = notices.add(
        BrowseNoticeKind::Refused,
        "model.zip",
        "four downloads are running",
    );
    assert_eq!(added.id, "n1");
    assert_eq!(added.file_name, "model.zip");
    assert_eq!(added.detail, "four downloads are running");
    assert_eq!(added.kind, BrowseNoticeKind::Refused);
    assert_eq!(added.at, 1234);
    assert_eq!(notices.list(), vec![added.clone()]);
    assert_eq!(raised.lock().unwrap().as_slice(), [added]);
}

#[test]
fn dismiss_removes_exactly_the_one_named_and_an_unknown_id_is_not_an_error() {
    let (notices, _) = notices();
    let first = notices.add(BrowseNoticeKind::Refused, "a", "x");
    let second = notices.add(BrowseNoticeKind::Completed, "b", "y");
    notices.dismiss(&first.id);
    assert_eq!(notices.list(), vec![second.clone()]);
    notices.dismiss(&first.id);
    notices.dismiss("never-existed");
    assert_eq!(notices.list(), vec![second]);
}

#[test]
fn the_list_is_a_copy_mutating_what_a_caller_was_handed_does_not_change_the_record() {
    let (notices, _) = notices();
    notices.add(BrowseNoticeKind::Refused, "a", "x");
    let mut list = notices.list();
    list.clear();
    assert_eq!(notices.list().len(), 1);
}

#[test]
fn site_authored_text_is_truncated_on_the_way_in_not_left_to_whoever_renders_it() {
    let (notices, raised) = notices();
    let long = "é".repeat(MAX_NOTICE_TEXT + 50);
    let added = notices.add(BrowseNoticeKind::Refused, &long, &long);
    assert_eq!(added.file_name.chars().count(), MAX_NOTICE_TEXT);
    assert_eq!(added.detail.chars().count(), MAX_NOTICE_TEXT);
    assert_eq!(notices.list()[0], added);
    assert_eq!(raised.lock().unwrap()[0], added);
}

#[test]
fn the_list_is_bounded_and_it_is_the_oldest_that_goes() {
    let (notices, _) = notices();
    for index in 0..MAX_NOTICES + 7 {
        notices.add(BrowseNoticeKind::Refused, &format!("file-{index}"), "x");
    }
    let list = notices.list();
    assert_eq!(list.len(), MAX_NOTICES);
    assert_eq!(list[0].file_name, "file-7");
    assert_eq!(
        list.last().unwrap().file_name,
        format!("file-{}", MAX_NOTICES + 6)
    );
}
