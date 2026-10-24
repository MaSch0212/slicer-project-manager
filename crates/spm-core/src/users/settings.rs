//! The `user_settings` storage: one row per (user, key), the value a single string.
//!
//! Each [`SettingsDto`] key has a codec that turns its typed value into that string and back.
//! Decoding returns `None` for any raw value the key does not currently accept, not only malformed
//! input but anything a codec has stopped recognising (an enum member a removed option used to
//! write), so [`get_settings`] lets the default stand instead of passing a stale or foreign value
//! through to the DTO (spec 3.2).

use std::collections::HashMap;
use std::marker::PhantomData;

use rusqlite::params;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ctx::Ctx;
use crate::db::Library;
use crate::dto::{DEFAULT_SETTINGS, SettingsDto, SettingsPatch};
use crate::error::Result;
use crate::validate::{self, Validate};

/// Stores a value as an enum member's wire spelling; any other raw value decodes to `None`. This
/// is what every enum-shaped key (theme, language, viewMode, sort, dir) uses.
pub fn encode_enum<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(text)) => text,
        // Every enum used here serialises to a string; anything else is a programming error that
        // must not corrupt the row.
        _ => String::new(),
    }
}

pub fn decode_enum<T: DeserializeOwned>(raw: &str) -> Option<T> {
    serde_json::from_value(Value::String(raw.to_owned())).ok()
}

/// Stores `true`/`false` as `"1"`/`"0"`; any other raw value decodes to `None`.
pub fn encode_bool(value: bool) -> String {
    if value { "1" } else { "0" }.to_owned()
}

pub fn decode_bool(raw: &str) -> Option<bool> {
    match raw {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// Stores any value its validator accepts as JSON text. Decoding returns `None` for malformed JSON
/// *and* for JSON that parses but fails the validator: the same "reject, don't corrupt" guarantee
/// the enum and boolean codecs give their keys. The validator turns the parsed JSON into the typed
/// value, or says no.
pub struct JsonCodec<T, F> {
    validate: F,
    _value: PhantomData<fn() -> T>,
}

impl<T: Serialize, F: Fn(Value) -> Option<T>> JsonCodec<T, F> {
    pub fn new(validate: F) -> Self {
        JsonCodec {
            validate,
            _value: PhantomData,
        }
    }

    pub fn encode(&self, value: &T) -> String {
        serde_json::to_string(value).unwrap_or_default()
    }

    pub fn decode(&self, raw: &str) -> Option<T> {
        let parsed: Value = serde_json::from_str(raw).ok()?;
        (self.validate)(parsed)
    }
}

/// The remembered tag filter: an array of valid tag names, at most 50.
fn filter_tags_codec() -> JsonCodec<Vec<String>, impl Fn(Value) -> Option<Vec<String>>> {
    JsonCodec::new(|value| {
        let tags: Vec<String> = serde_json::from_value(value).ok()?;
        validate::filter_tags(&tags).ok()
    })
}

/// A user's settings: the shipped defaults, overlaid with whatever valid rows they have stored.
pub fn get_settings(lib: &Library, ctx: &Ctx) -> Result<SettingsDto> {
    let stored: HashMap<String, String> = {
        let conn = lib.db();
        let mut statement = conn.prepare(
            "SELECT key, value FROM user_settings WHERE user_id = ? AND value IS NOT NULL",
        )?;
        let rows = statement.query_map(params![ctx.user_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    // Unknown or stale keys, and rows whose codec no longer accepts them, fall back to the
    // default rather than corrupting the DTO.
    let mut settings = DEFAULT_SETTINGS;
    let get = |key: &str| stored.get(key).map(String::as_str);
    if let Some(theme) = get("theme").and_then(decode_enum) {
        settings.theme = theme;
    }
    if let Some(language) = get("language").and_then(decode_enum) {
        settings.language = language;
    }
    if let Some(view_mode) = get("viewMode").and_then(decode_enum) {
        settings.view_mode = view_mode;
    }
    if let Some(sort) = get("sort").and_then(decode_enum) {
        settings.sort = sort;
    }
    if let Some(dir) = get("dir").and_then(decode_enum) {
        settings.dir = dir;
    }
    if let Some(collapsed) = get("navCollapsed").and_then(decode_bool) {
        settings.nav_collapsed = collapsed;
    }
    if let Some(include) = get("includeArchived").and_then(decode_bool) {
        settings.include_archived = include;
    }
    if let Some(tags) = get("filterTags").and_then(|raw| filter_tags_codec().decode(raw)) {
        settings.filter_tags = tags;
    }
    Ok(settings)
}

/// Stores the keys `patch` names (and only those) and returns the merged settings. The patch is
/// validated first, so a bad one changes nothing; the keys land in one transaction.
pub fn put_settings(lib: &Library, ctx: &Ctx, patch: SettingsPatch) -> Result<SettingsDto> {
    let patch = patch.validate()?;
    let mut entries: Vec<(&str, String)> = Vec::new();
    if let Some(theme) = &patch.theme {
        entries.push(("theme", encode_enum(theme)));
    }
    if let Some(language) = &patch.language {
        entries.push(("language", encode_enum(language)));
    }
    if let Some(view_mode) = &patch.view_mode {
        entries.push(("viewMode", encode_enum(view_mode)));
    }
    if let Some(sort) = &patch.sort {
        entries.push(("sort", encode_enum(sort)));
    }
    if let Some(dir) = &patch.dir {
        entries.push(("dir", encode_enum(dir)));
    }
    if let Some(collapsed) = patch.nav_collapsed {
        entries.push(("navCollapsed", encode_bool(collapsed)));
    }
    if let Some(include) = patch.include_archived {
        entries.push(("includeArchived", encode_bool(include)));
    }
    if let Some(tags) = &patch.filter_tags {
        entries.push(("filterTags", filter_tags_codec().encode(tags)));
    }

    {
        let mut conn = lib.db();
        let tx = conn.transaction()?;
        for (key, value) in &entries {
            tx.execute(
                "INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
                 ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
                params![ctx.user_id, key, value],
            )?;
        }
        tx.commit()?;
    }
    get_settings(lib, ctx)
}
