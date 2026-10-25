//! What the app has to say about downloads that happened while nobody was watching.
//!
//! **Two events need it, and both are silent without it.**
//!
//! 1. **A refusal.** Nothing at all is delivered to the page when a download is refused: from the
//!    site's point of view the click did nothing, which is indistinguishable from a consent overlay
//!    eating it. Silence here trains a user to believe the feature is broken, so the shell says
//!    which download was refused and which cap it hit.
//! 2. **A download that finished while no view was attached.** Nothing polls the downloads once
//!    `/browse` is torn down, so a completed download would be sitting there the next time the user
//!    happened to look.
//!
//! **The notification is the promptness and the list is the record.** An operating system that
//! suppresses notifications costs the user nothing they cannot get back, because the notices and
//! the downloads both still answer.
//!
//! In memory, for the life of the process, and deliberately not on disk: a notice is an
//! interruption about something that just happened, and the durable half of the same event is the
//! download's record. `notify` is required, not defaulted, so a wiring mistake cannot put the app
//! back in the silence this module exists to end. The text is English, like `lastError`: it is a
//! sentence this process writes about a stranger's file.

use std::sync::{Arc, Mutex};

use spm_core::dto::{BrowseNoticeDto, BrowseNoticeKind};

/// The longest `file_name` or `detail` a notice carries. A judgement: `file_name` comes from a
/// remote server, and the string ends up in the app's own chrome and in a system notification.
pub const MAX_NOTICE_TEXT: usize = 200;

/// How many notices are kept. A judgement: what it bounds is a page that starts downloads in a
/// loop, where every refusal appends. The oldest go first.
pub const MAX_NOTICES: usize = 50;

pub type Notify = Arc<dyn Fn(&BrowseNoticeDto) + Send + Sync>;

pub struct BrowseNotices {
    notify: Notify,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    mint_id: Arc<dyn Fn() -> String + Send + Sync>,
    notices: Mutex<Vec<BrowseNoticeDto>>,
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

impl BrowseNotices {
    pub fn new(notify: Notify) -> BrowseNotices {
        BrowseNotices {
            notify,
            now: Arc::new(spm_core::clock::now_ms),
            mint_id: Arc::new(spm_core::new_id),
            notices: Mutex::new(Vec::new()),
        }
    }

    pub fn with_clock(mut self, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> BrowseNotices {
        self.now = now;
        self
    }

    pub fn with_ids(mut self, mint_id: Arc<dyn Fn() -> String + Send + Sync>) -> BrowseNotices {
        self.mint_id = mint_id;
        self
    }

    /// Appends one and raises the notification for it, in that order. The order is not
    /// decorative: `notify` reaches the operating system, and a failure there must not be able to
    /// cost the app the record of what happened.
    pub fn add(&self, kind: BrowseNoticeKind, file_name: &str, detail: &str) -> BrowseNoticeDto {
        let notice = BrowseNoticeDto {
            id: (self.mint_id)(),
            kind,
            file_name: clip(file_name, MAX_NOTICE_TEXT),
            detail: clip(detail, MAX_NOTICE_TEXT),
            at: (self.now)(),
        };
        {
            let mut notices = self.notices.lock().unwrap_or_else(|e| e.into_inner());
            notices.push(notice.clone());
            if notices.len() > MAX_NOTICES {
                let excess = notices.len() - MAX_NOTICES;
                notices.drain(..excess);
            }
        }
        (self.notify)(&notice);
        notice
    }

    /// Oldest first. A copy, so a caller cannot edit the record by editing what it was handed.
    pub fn list(&self) -> Vec<BrowseNoticeDto> {
        self.notices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Forgets one. An id that is not there is a success: the page polls this list, so "dismiss
    /// the card I am looking at" races every other reason a notice could already be gone.
    pub fn dismiss(&self, id: &str) {
        self.notices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|notice| notice.id != id);
    }
}
