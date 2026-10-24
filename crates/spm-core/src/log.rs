//! A tiny level-filtered logger.
//!
//! It lives in core because the things most worth logging (the preview queue, rescan,
//! authentication) are core behaviour, and the desktop app runs that same code with no HTTP server
//! around it. Core stays host-neutral: nothing here reads an environment variable or opens a file.
//! The *level* arrives as a value and the *destination* arrives as a sink. A host that wants
//! `tracing` writes a sink that forwards records to it; the server turns `SPM_LOG_LEVEL` into the
//! level.
//!
//! **Silent unless configured.** A library opened without a logger gets [`Logger::noop`]. The crate
//! also denies `print!`/`eprintln!` outside [`console_sink`], so "importing core must not print" is
//! enforced by the compiler and not by a convention.

use std::fmt;
use std::sync::{Arc, OnceLock};

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::{self, OwnedFormatItem};

/// Ordered most severe first. A logger at level L emits every level at or above it in this list.
pub const LOG_LEVELS: [LogLevel; 5] = [
    LogLevel::Error,
    LogLevel::Warn,
    LogLevel::Info,
    LogLevel::Debug,
    LogLevel::Trace,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }

    fn severity(self) -> i8 {
        match self {
            LogLevel::Error => 0,
            LogLevel::Warn => 1,
            LogLevel::Info => 2,
            LogLevel::Debug => 3,
            LogLevel::Trace => 4,
        }
    }
}

/// `Silent` is a configuration choice, not something you can call: there is no `log.silent()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogLevelSetting {
    Silent,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevelSetting {
    fn severity(self) -> i8 {
        match self {
            LogLevelSetting::Silent => -1,
            LogLevelSetting::Error => 0,
            LogLevelSetting::Warn => 1,
            LogLevelSetting::Info => 2,
            LogLevelSetting::Debug => 3,
            LogLevelSetting::Trace => 4,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LogLevelSetting::Silent => "silent",
            LogLevelSetting::Error => "error",
            LogLevelSetting::Warn => "warn",
            LogLevelSetting::Info => "info",
            LogLevelSetting::Debug => "debug",
            LogLevelSetting::Trace => "trace",
        }
    }
}

impl From<LogLevel> for LogLevelSetting {
    fn from(level: LogLevel) -> LogLevelSetting {
        match level {
            LogLevel::Error => LogLevelSetting::Error,
            LogLevel::Warn => LogLevelSetting::Warn,
            LogLevel::Info => LogLevelSetting::Info,
            LogLevel::Debug => LogLevelSetting::Debug,
            LogLevel::Trace => LogLevelSetting::Trace,
        }
    }
}

pub const DEFAULT_LOG_LEVEL: LogLevelSetting = LogLevelSetting::Info;

/// Accepts any case and surrounding whitespace; `None` for anything unrecognised so the caller can
/// complain.
pub fn parse_log_level(raw: Option<&str>) -> Option<LogLevelSetting> {
    match raw?.trim().to_lowercase().as_str() {
        "silent" => Some(LogLevelSetting::Silent),
        "error" => Some(LogLevelSetting::Error),
        "warn" => Some(LogLevelSetting::Warn),
        "info" => Some(LogLevelSetting::Info),
        "debug" => Some(LogLevelSetting::Debug),
        "trace" => Some(LogLevelSetting::Trace),
        _ => None,
    }
}

/// One field value of a record.
#[derive(Debug, Clone, PartialEq)]
pub enum LogValue {
    Str(String),
    Int(i64),
    UInt(u64),
    Float(f64),
    Bool(bool),
    /// An error, already rendered as `Name: message`.
    Error(String),
    Json(Value),
}

impl LogValue {
    /// An error value, rendered the way the legacy logger rendered an `Error`: `Error: message`.
    pub fn error(error: &dyn fmt::Display) -> LogValue {
        LogValue::Error(format!("Error: {error}"))
    }
}

impl From<&str> for LogValue {
    fn from(value: &str) -> LogValue {
        LogValue::Str(value.to_owned())
    }
}
impl From<String> for LogValue {
    fn from(value: String) -> LogValue {
        LogValue::Str(value)
    }
}
impl From<&String> for LogValue {
    fn from(value: &String) -> LogValue {
        LogValue::Str(value.clone())
    }
}
impl From<bool> for LogValue {
    fn from(value: bool) -> LogValue {
        LogValue::Bool(value)
    }
}
impl From<i32> for LogValue {
    fn from(value: i32) -> LogValue {
        LogValue::Int(value.into())
    }
}
impl From<i64> for LogValue {
    fn from(value: i64) -> LogValue {
        LogValue::Int(value)
    }
}
impl From<u32> for LogValue {
    fn from(value: u32) -> LogValue {
        LogValue::UInt(value.into())
    }
}
impl From<u64> for LogValue {
    fn from(value: u64) -> LogValue {
        LogValue::UInt(value)
    }
}
impl From<usize> for LogValue {
    fn from(value: usize) -> LogValue {
        LogValue::UInt(value as u64)
    }
}
impl From<f64> for LogValue {
    fn from(value: f64) -> LogValue {
        LogValue::Float(value)
    }
}
impl From<Value> for LogValue {
    fn from(value: Value) -> LogValue {
        LogValue::Json(value)
    }
}
impl<T: Into<LogValue>> From<Option<T>> for LogValue {
    fn from(value: Option<T>) -> LogValue {
        value.map_or(LogValue::Json(Value::Null), Into::into)
    }
}

/// Fields in the order they were first set. A clash keeps the earlier position and takes the later
/// value, as an object spread does.
pub type LogFields = Vec<(String, LogValue)>;

/// Builds the `&[(&str, LogValue)]` the logging methods take:
/// `log.info("login", fields!["userId" => id, "ok" => true])`.
#[macro_export]
macro_rules! fields {
    () => {
        &[] as &[(&str, $crate::log::LogValue)]
    };
    ($($key:expr => $value:expr),+ $(,)?) => {
        &[$(($key, $crate::log::LogValue::from($value))),+] as &[(&str, $crate::log::LogValue)]
    };
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    pub level: LogLevel,
    /// Epoch milliseconds, injectable via [`LoggerOptions::now`] so tests get stable output.
    pub time: i64,
    pub message: String,
    pub fields: LogFields,
}

impl LogRecord {
    /// The value of a field, if the record carries it.
    pub fn field(&self, name: &str) -> Option<&LogValue> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }
}

pub type LogSink = Arc<dyn Fn(&LogRecord) + Send + Sync>;

fn is_bare(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '@' | '+' | '-')
        })
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"[unserializable]\"".to_owned())
}

fn format_value(value: &LogValue) -> String {
    match value {
        LogValue::Error(text) => json_string(text),
        // Quote only when the bare form would be ambiguous, so the common case stays readable.
        LogValue::Str(text) if is_bare(text) => text.clone(),
        LogValue::Str(text) => json_string(text),
        LogValue::Int(n) => n.to_string(),
        LogValue::UInt(n) => n.to_string(),
        LogValue::Bool(b) => b.to_string(),
        LogValue::Float(f) if !f.is_finite() => "null".to_owned(),
        LogValue::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
        LogValue::Float(f) => f.to_string(),
        LogValue::Json(json) => {
            serde_json::to_string(json).unwrap_or_else(|_| "[unserializable]".to_owned())
        }
    }
}

fn iso_format() -> &'static OwnedFormatItem {
    static FORMAT: OnceLock<OwnedFormatItem> = OnceLock::new();
    FORMAT.get_or_init(|| {
        format_description::parse_owned::<2>(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
        )
        .expect("the timestamp format is a constant")
    })
}

fn format_time(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|moment| moment.format(iso_format()).ok())
        .unwrap_or_else(|| ms.to_string())
}

/// `<iso> LEVEL message key=value`: greppable, and readable without a log viewer.
pub fn format_record(record: &LogRecord) -> String {
    let head = format!(
        "{} {:<5} {}",
        format_time(record.time),
        record.level.as_str().to_uppercase(),
        record.message
    );
    if record.fields.is_empty() {
        return head;
    }
    let fields = record
        .fields
        .iter()
        .map(|(key, value)| format!("{key}={}", format_value(value)))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{head} {fields}")
}

/// Writes formatted lines to the console, splitting by severity so that `error` and `warn` reach
/// stderr: a shell pipeline that keeps only stdout should still surface failures.
#[allow(clippy::print_stdout, clippy::print_stderr)]
pub fn console_sink(record: &LogRecord) {
    let line = format_record(record);
    match record.level {
        LogLevel::Error | LogLevel::Warn => eprintln!("{line}"),
        _ => println!("{line}"),
    }
}

#[derive(Clone, Default)]
pub struct LoggerOptions {
    /// Defaults to [`DEFAULT_LOG_LEVEL`].
    pub level: Option<LogLevelSetting>,
    /// Defaults to [`console_sink`].
    pub sink: Option<LogSink>,
    pub fields: LogFields,
    /// Defaults to the system clock.
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
}

#[derive(Clone)]
pub struct Logger {
    level: LogLevelSetting,
    sink: LogSink,
    bound: LogFields,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl fmt::Debug for Logger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Logger")
            .field("level", &self.level)
            .finish_non_exhaustive()
    }
}

fn merge(base: &LogFields, extra: &[(&str, LogValue)]) -> LogFields {
    let mut merged = base.clone();
    for (key, value) in extra {
        match merged.iter_mut().find(|(existing, _)| existing == key) {
            Some(slot) => slot.1 = value.clone(),
            None => merged.push(((*key).to_owned(), value.clone())),
        }
    }
    merged
}

impl Logger {
    pub fn new(options: LoggerOptions) -> Logger {
        Logger {
            level: options.level.unwrap_or(DEFAULT_LOG_LEVEL),
            sink: options.sink.unwrap_or_else(|| Arc::new(console_sink)),
            bound: options.fields,
            now: options
                .now
                .unwrap_or_else(|| Arc::new(crate::clock::now_ms)),
        }
    }

    /// The default for every library that does not ask for logging: silent, and safe to call.
    pub fn noop() -> Logger {
        Logger::new(LoggerOptions {
            level: Some(LogLevelSetting::Silent),
            sink: Some(Arc::new(|_| {})),
            ..LoggerOptions::default()
        })
    }

    /// A logger at `level` that hands every record to `sink`.
    pub fn with_sink(level: LogLevelSetting, sink: LogSink) -> Logger {
        Logger::new(LoggerOptions {
            level: Some(level),
            sink: Some(sink),
            ..Default::default()
        })
    }

    pub fn level(&self) -> LogLevelSetting {
        self.level
    }

    /// True when a record at `level` would be emitted. Guard genuinely expensive field-building
    /// with this; ordinary calls need no guard, since the level check happens before formatting.
    pub fn enabled(&self, level: LogLevel) -> bool {
        level.severity() <= self.level.severity()
    }

    pub fn log(&self, level: LogLevel, message: &str, fields: &[(&str, LogValue)]) {
        if !self.enabled(level) {
            return;
        }
        // Call-site fields win over bound ones, so a child's default can be overridden per call.
        (self.sink)(&LogRecord {
            level,
            time: (self.now)(),
            message: message.to_owned(),
            fields: merge(&self.bound, fields),
        });
    }

    pub fn error(&self, message: &str, fields: &[(&str, LogValue)]) {
        self.log(LogLevel::Error, message, fields);
    }
    pub fn warn(&self, message: &str, fields: &[(&str, LogValue)]) {
        self.log(LogLevel::Warn, message, fields);
    }
    pub fn info(&self, message: &str, fields: &[(&str, LogValue)]) {
        self.log(LogLevel::Info, message, fields);
    }
    pub fn debug(&self, message: &str, fields: &[(&str, LogValue)]) {
        self.log(LogLevel::Debug, message, fields);
    }
    pub fn trace(&self, message: &str, fields: &[(&str, LogValue)]) {
        self.log(LogLevel::Trace, message, fields);
    }

    /// A logger that merges `fields` into everything it emits: a request id, a user id. It keeps
    /// this logger's level, sink and clock; this logger is unaffected.
    pub fn child(&self, fields: &[(&str, LogValue)]) -> Logger {
        Logger {
            level: self.level,
            sink: Arc::clone(&self.sink),
            bound: merge(&self.bound, fields),
            now: Arc::clone(&self.now),
        }
    }
}

impl Default for Logger {
    fn default() -> Logger {
        Logger::noop()
    }
}
