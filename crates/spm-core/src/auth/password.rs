use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use super::tokens::{random_bytes, timing_safe_equal};

pub const PW_ALGO: &str = "pbkdf2-sha256";
pub const PW_ITERATIONS: u32 = 600_000;
pub const PW_SALT_BYTES: usize = 16;
pub const PW_KEY_BYTES: usize = 32;

/// A password hash with the parameters it was made under, exactly the four `users.pw_*` columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordHash {
    pub hash: Vec<u8>,
    pub salt: Vec<u8>,
    pub iterations: i64,
    pub algo: String,
}

fn derive(password: &str, salt: &[u8], iterations: u32) -> [u8; PW_KEY_BYTES] {
    // NFKC first: the same typed password must hash the same on every platform, and an existing
    // hash was made over the NFKC form.
    let normalized: String = password.nfkc().collect();
    let mut out = [0u8; PW_KEY_BYTES];
    pbkdf2_hmac::<Sha256>(normalized.as_bytes(), salt, iterations, &mut out);
    out
}

/// Hashes `password` with a fresh random salt under the production parameters.
pub fn hash_password(password: &str) -> PasswordHash {
    hash_password_with(password, PW_ITERATIONS)
}

/// As [`hash_password`] with an explicit iteration count: for tests that need a deliberately weak
/// hash. Production code uses [`hash_password`].
pub fn hash_password_with(password: &str, iterations: u32) -> PasswordHash {
    let salt = random_bytes(PW_SALT_BYTES);
    PasswordHash {
        hash: derive(password, &salt, iterations).to_vec(),
        salt,
        iterations: i64::from(iterations),
        algo: PW_ALGO.to_owned(),
    }
}

pub fn verify_password(password: &str, stored: &PasswordHash) -> bool {
    if stored.algo != PW_ALGO {
        return false;
    }
    let Ok(iterations) = u32::try_from(stored.iterations) else {
        return false;
    };
    if iterations == 0 {
        return false;
    }
    timing_safe_equal(&derive(password, &stored.salt, iterations), &stored.hash)
}

/// True when the stored parameters are weaker than today's policy (spec 5.1).
pub fn needs_rehash(iterations: i64, algo: &str) -> bool {
    algo != PW_ALGO || iterations < i64::from(PW_ITERATIONS)
}
