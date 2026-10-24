/// Every use case takes one of these. Ownership is scoped by `user_id` inside core (parent spec
/// 2.2): a transport authenticates, builds a `Ctx`, and core does the authorising.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ctx {
    pub user_id: String,
    pub is_admin: bool,
}
