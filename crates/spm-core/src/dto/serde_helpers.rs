//! Serde glue for the one shape plain `Option` cannot express.

use serde::{Deserialize, Deserializer};

/// For a field typed `Option<Option<T>>` that distinguishes three states on the wire:
///
/// * key absent: `None` (use together with `#[serde(default)]`),
/// * key present and `null`: `Some(None)`,
/// * key present with a value: `Some(Some(value))`.
///
/// This is what lets a patch say "leave the website alone" and "clear the website" differently.
pub(crate) fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
