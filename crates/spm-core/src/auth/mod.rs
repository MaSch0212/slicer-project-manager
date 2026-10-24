//! Passwords, sessions, activation tokens and login.
//!
//! Tokens are opaque 256-bit random strings; only their SHA-256 is stored, so a leaked database
//! hands out no usable session or invite. Passwords are PBKDF2-HMAC-SHA256 with the parameters
//! stored per user, so a hash made under older parameters keeps verifying and is upgraded on the
//! next successful login. Everything that touches the database takes a [`crate::Library`].

pub mod activation;
pub mod login;
pub mod password;
pub mod sessions;
pub mod tokens;
