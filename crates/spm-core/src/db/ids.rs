/// An opaque primary key: a random (version 4) UUID in its canonical lowercase hyphenated form,
/// the same text `crypto.randomUUID()` produced.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
