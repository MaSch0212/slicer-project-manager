use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// `len` bytes from the operating system's CSPRNG.
///
/// # Panics
/// If the OS cannot supply randomness, which leaves nothing safe to do.
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("the operating system's random source is unavailable");
    bytes
}

/// 256 random bits as 43 base64url characters (no padding), safe in a URL fragment and a cookie.
pub fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes(32))
}

pub fn sha256_bytes(input: impl AsRef<[u8]>) -> [u8; 32] {
    Sha256::digest(input.as_ref()).into()
}

/// Equal-length, constant-time comparison; different lengths are simply unequal.
pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}
