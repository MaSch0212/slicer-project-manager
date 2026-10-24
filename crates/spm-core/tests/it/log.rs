use std::sync::{Arc, Mutex};

use serde_json::json;
use spm_core::fields;
use spm_core::log::{
    LOG_LEVELS, LogLevel, LogLevelSetting, LogRecord, LogValue, Logger, LoggerOptions,
    format_record, parse_log_level,
};

type Records = Arc<Mutex<Vec<LogRecord>>>;

fn collector() -> (Records, spm_core::log::LogSink) {
    let records: Records = Arc::default();
    let sink_records = Arc::clone(&records);
    (
        records,
        Arc::new(move |record| sink_records.lock().unwrap().push(record.clone())),
    )
}

fn logger(level: Option<LogLevelSetting>, sink: spm_core::log::LogSink) -> Logger {
    Logger::new(LoggerOptions {
        level,
        sink: Some(sink),
        ..Default::default()
    })
}

fn emit_every_level(log: &Logger) {
    for level in LOG_LEVELS {
        log.log(level, level.as_str(), fields![]);
    }
}

fn messages(records: &Records) -> Vec<String> {
    records
        .lock()
        .unwrap()
        .iter()
        .map(|record| record.message.clone())
        .collect()
}

/// 2026-08-23T14:11:02.123Z
const FIXED: i64 = 1_787_494_262_123;

#[test]
fn a_logger_emits_its_own_level_and_everything_more_severe_and_drops_the_rest() {
    for (index, level) in LOG_LEVELS.iter().enumerate() {
        let (records, sink) = collector();
        let log = logger(Some((*level).into()), sink);
        emit_every_level(&log);

        let expected: Vec<&str> = LOG_LEVELS[..=index]
            .iter()
            .map(|level| level.as_str())
            .collect();
        assert_eq!(messages(&records), expected, "at level {level:?}");
        // Every level must be a real boundary: the next one down has to actually be excluded.
        for missing in &LOG_LEVELS[index + 1..] {
            assert!(
                !messages(&records)
                    .iter()
                    .any(|message| message == missing.as_str()),
                "{missing:?} leaked at {level:?}"
            );
        }
    }
}

#[test]
fn silent_emits_nothing_at_all() {
    let (records, sink) = collector();
    let log = logger(Some(LogLevelSetting::Silent), sink);
    emit_every_level(&log);
    assert!(records.lock().unwrap().is_empty());
    assert!(!log.enabled(LogLevel::Error));
}

#[test]
fn the_default_level_is_info() {
    let (records, sink) = collector();
    let log = logger(None, sink);
    log.info("shown", fields![]);
    log.debug("hidden", fields![]);
    assert_eq!(messages(&records), ["shown"]);
}

#[test]
fn enabled_agrees_with_what_is_actually_emitted() {
    let (records, sink) = collector();
    let log = logger(Some(LogLevelSetting::Warn), sink);
    for level in LOG_LEVELS {
        records.lock().unwrap().clear();
        log.log(level, "x", fields![]);
        assert_eq!(
            log.enabled(level),
            records.lock().unwrap().len() == 1,
            "enabled({level:?})"
        );
    }
}

#[test]
fn child_merges_bound_fields_and_the_call_site_wins_on_a_clash() {
    let (records, sink) = collector();
    let log = Logger::new(LoggerOptions {
        sink: Some(sink),
        fields: vec![("app".to_owned(), "spm".into())],
        ..Default::default()
    })
    .child(fields!["requestId" => "r1", "app" => "child"]);
    log.info(
        "hello",
        fields!["userId" => "u1", "requestId" => "override"],
    );

    let fields = records.lock().unwrap()[0].fields.clone();
    assert_eq!(
        fields,
        [
            ("app".to_owned(), LogValue::from("child")),
            ("requestId".to_owned(), LogValue::from("override")),
            ("userId".to_owned(), LogValue::from("u1")),
        ]
    );
}

#[test]
fn child_inherits_the_level_rather_than_resetting_it_to_the_default() {
    let (records, sink) = collector();
    let log = logger(Some(LogLevelSetting::Error), sink).child(fields!["requestId" => "r1"]);
    log.info("must not appear", fields![]);
    log.error("must appear", fields![]);
    assert_eq!(messages(&records), ["must appear"]);
}

#[test]
fn a_parent_logger_is_unaffected_by_its_child() {
    let (records, sink) = collector();
    let parent = Logger::new(LoggerOptions {
        sink: Some(sink),
        fields: vec![("app".to_owned(), "spm".into())],
        ..Default::default()
    });
    let _child = parent.child(fields!["requestId" => "r1"]);
    parent.info("plain", fields![]);
    assert_eq!(
        records.lock().unwrap()[0].fields,
        [("app".to_owned(), LogValue::from("spm"))]
    );
}

#[test]
fn parse_log_level_accepts_the_known_names_in_any_case_and_rejects_the_rest() {
    assert_eq!(parse_log_level(Some("DEBUG")), Some(LogLevelSetting::Debug));
    assert_eq!(
        parse_log_level(Some("  warn ")),
        Some(LogLevelSetting::Warn)
    );
    assert_eq!(
        parse_log_level(Some("silent")),
        Some(LogLevelSetting::Silent)
    );
    assert_eq!(parse_log_level(Some("verbose")), None);
    assert_eq!(parse_log_level(Some("")), None);
    assert_eq!(parse_log_level(None), None);
}

fn record(level: LogLevel, message: &str, fields: Vec<(&str, LogValue)>) -> LogRecord {
    LogRecord {
        level,
        time: FIXED,
        message: message.to_owned(),
        fields: fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    }
}

#[test]
fn format_record_renders_the_timestamp_level_message_and_fields() {
    let line = format_record(&record(
        LogLevel::Info,
        "request",
        vec![
            ("method", "GET".into()),
            ("path", "/api/projects".into()),
            ("ms", 12.into()),
            ("ok", true.into()),
        ],
    ));
    assert_eq!(
        line,
        "2026-08-23T14:11:02.123Z INFO  request method=GET path=/api/projects ms=12 ok=true"
    );
}

#[test]
fn format_record_quotes_values_that_would_otherwise_be_ambiguous() {
    let line = format_record(&record(
        LogLevel::Warn,
        "odd",
        vec![
            ("name", "two words".into()),
            ("empty", "".into()),
            ("err", LogValue::error(&"boom")),
            ("nested", json!({"a": 1}).into()),
        ],
    ));
    assert_eq!(
        line,
        r#"2026-08-23T14:11:02.123Z WARN  odd name="two words" empty="" err="Error: boom" nested={"a":1}"#
    );
}

// The legacy test fed a circular object to the formatter. A `LogValue` is a tree and cannot be
// circular, so that failure mode does not exist here; the closest property worth pinning is that
// formatting is total over every value a field can hold.
#[test]
fn format_record_is_total_over_every_field_value() {
    let line = format_record(&record(
        LogLevel::Info,
        "m",
        vec![
            ("nan", f64::NAN.into()),
            ("inf", f64::INFINITY.into()),
            ("whole", 3.0.into()),
            ("frac", 1.5.into()),
            ("none", Option::<&str>::None.into()),
        ],
    ));
    assert!(
        line.ends_with("nan=null inf=null whole=3 frac=1.5 none=null"),
        "{line}"
    );
}

#[test]
fn a_record_carries_the_injected_clock() {
    let (records, sink) = collector();
    Logger::new(LoggerOptions {
        sink: Some(sink),
        now: Some(Arc::new(|| FIXED)),
        ..Default::default()
    })
    .info("m", fields![]);
    assert_eq!(records.lock().unwrap()[0].time, FIXED);
}

#[test]
fn noop_logger_is_silent_and_still_safe_to_call() {
    let log = Logger::noop();
    log.error("nothing happens", fields![]);
    assert_eq!(log.level(), LogLevelSetting::Silent);
    assert!(!log.enabled(LogLevel::Error));
}
