//! Application behaviour: db, auth, files, projects, import, previews.

/// The application's display name.
pub fn app_name() -> &'static str {
    "Slicer Project Manager"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_app() {
        assert_eq!(app_name(), "Slicer Project Manager");
    }
}
