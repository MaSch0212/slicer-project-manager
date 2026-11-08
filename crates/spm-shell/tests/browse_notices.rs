//! Ported from `browse-notices.test.ts`: the out-of-band notices — what the app has to say about
//! a download nobody was watching, when nothing on screen can say it.
//!
//! The remembered-last-page half of this file went with `browse::last_page`: the tabs now live as
//! long as the process and no longer, so there is no file to test. `browse_host.rs` pins that a
//! fresh run starts on the registry's page.

use std::sync::{Arc, Mutex};

use spm_core::dto::{BrowseNoticeDto, BrowseNoticeKind};
use spm_shell::browse::notices::{BrowseNotices, MAX_NOTICE_TEXT, MAX_NOTICES};

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
