//! The application error type.
//!
//! The string codes are part of the wire contract: the UI maps each one to an i18n key, so a code
//! may be added but never renamed. They serialise exactly as the legacy `AppErrorCode` union did.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Every error code the API can answer with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum AppErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Validation,
    QuotaExceeded,
    LengthRequired,
    InvalidToken,
    TokenExpired,
    LastActiveAdmin,
    TooManyRequests,
    Internal,
}

impl AppErrorCode {
    /// Every code, in declaration order. A code arriving from somewhere untrusted is checked
    /// against this (see [`AppErrorCode::parse`]) rather than cast into the enum.
    pub const ALL: [AppErrorCode; 12] = [
        AppErrorCode::Unauthorized,
        AppErrorCode::Forbidden,
        AppErrorCode::NotFound,
        AppErrorCode::Conflict,
        AppErrorCode::Validation,
        AppErrorCode::QuotaExceeded,
        AppErrorCode::LengthRequired,
        AppErrorCode::InvalidToken,
        AppErrorCode::TokenExpired,
        AppErrorCode::LastActiveAdmin,
        AppErrorCode::TooManyRequests,
        AppErrorCode::Internal,
    ];

    /// The wire spelling, identical to the variant name.
    pub fn as_str(self) -> &'static str {
        match self {
            AppErrorCode::Unauthorized => "Unauthorized",
            AppErrorCode::Forbidden => "Forbidden",
            AppErrorCode::NotFound => "NotFound",
            AppErrorCode::Conflict => "Conflict",
            AppErrorCode::Validation => "Validation",
            AppErrorCode::QuotaExceeded => "QuotaExceeded",
            AppErrorCode::LengthRequired => "LengthRequired",
            AppErrorCode::InvalidToken => "InvalidToken",
            AppErrorCode::TokenExpired => "TokenExpired",
            AppErrorCode::LastActiveAdmin => "LastActiveAdmin",
            AppErrorCode::TooManyRequests => "TooManyRequests",
            AppErrorCode::Internal => "Internal",
        }
    }

    /// The code spelled `value`, or `None` for anything that is not one of the twelve.
    pub fn parse(value: &str) -> Option<AppErrorCode> {
        AppErrorCode::ALL
            .into_iter()
            .find(|code| code.as_str() == value)
    }
}

impl fmt::Display for AppErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `details.reason` on the `Internal` raised when slicer detection could not run at all.
///
/// It lives with the error type because it crosses the transport boundary: the slicer settings
/// page switches on it to tell "detection did not run" apart from every other `Internal`.
pub const DETECTION_FAILED: &str = "detection-failed";

/// `details` of a `QuotaExceeded`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuotaExceededDetails {
    #[ts(type = "number")]
    pub usage_bytes: i64,
    #[ts(type = "number")]
    pub quota_bytes: i64,
    #[ts(type = "number")]
    pub incoming_bytes: i64,
}

/// The error body every failed API call carries: `{ "error": { code, message, details } }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ErrorBody {
    pub code: AppErrorCode,
    pub message: String,
    #[ts(type = "Record<string, unknown>")]
    pub details: Map<String, Value>,
}

/// The JSON envelope around an `ErrorBody`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

/// What every use case in core fails with.
///
/// `message` and `details` are safe to show a client. `cause` is not: it carries the text of an
/// underlying database or I/O error and exists so a transport can log it. It is never serialised.
#[derive(Debug, Clone, PartialEq)]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,
    pub details: Option<Map<String, Value>>,
    pub cause: Option<String>,
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;

impl AppError {
    pub fn new(code: AppErrorCode, message: impl Into<String>) -> AppError {
        AppError {
            code,
            message: message.into(),
            details: None,
            cause: None,
        }
    }

    pub fn with_details(mut self, details: Map<String, Value>) -> AppError {
        self.details = Some(details);
        self
    }

    pub fn unauthorized(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::Unauthorized, message)
    }

    pub fn forbidden(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::Forbidden, message)
    }

    pub fn not_found(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::Conflict, message)
    }

    pub fn validation(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::Validation, message)
    }

    pub fn invalid_token(message: impl Into<String>) -> AppError {
        AppError::new(AppErrorCode::InvalidToken, message)
    }

    /// An unexpected failure. The client sees only `message`; `cause` is for the server's log.
    pub fn internal(cause: impl fmt::Display) -> AppError {
        AppError {
            code: AppErrorCode::Internal,
            message: "internal error".to_owned(),
            details: None,
            cause: Some(cause.to_string()),
        }
    }

    pub fn quota_exceeded(details: QuotaExceededDetails) -> AppError {
        let mut map = Map::new();
        map.insert("usageBytes".into(), details.usage_bytes.into());
        map.insert("quotaBytes".into(), details.quota_bytes.into());
        map.insert("incomingBytes".into(), details.incoming_bytes.into());
        AppError::new(AppErrorCode::QuotaExceeded, "storage quota exceeded").with_details(map)
    }

    /// The wire form of this error. `details` is `{}` when there are none, as it always was.
    pub fn to_envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            error: ErrorBody {
                code: self.code,
                message: self.message.clone(),
                details: self.details.clone().unwrap_or_default(),
            },
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> AppError {
        AppError::internal(error)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> AppError {
        AppError::internal(error)
    }
}
