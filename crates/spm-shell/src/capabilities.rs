//! Spec 2.4's capability model, which is the one part of this app only the desktop shell can
//! exercise in full: it is the only client that can be pointed at two different backends.
//!
//! The model is two columns and a union. The **shell** contributes what the process it runs in can
//! do (open a native folder dialog, launch a slicer, embed a model browser). The **backend**
//! contributes what the thing holding the data can do (require a login, host user accounts). A
//! browser has one shell column and one backend column and never notices the difference; the
//! desktop app pointed at a remote server needs remote auth *and* local slicer launching at the
//! same time, which is the row a build-time flag cannot express.
//!
//! The web app reads one `GET /api/capabilities` and keys everything off it. The desktop's
//! loopback listener answers that one request itself (see [`crate::server`]): local mode answers
//! the union of the local shell column with the local backend's, and remote mode unions the
//! remote shell column into whatever the proxied server said.

use serde_json::Value;
use spm_core::dto::Capabilities;

/// The shell's column in **local folder** mode (spec 2.4, second column).
///
/// `requires_auth: false` is what spec 2.6 says local mode is. `can_pick_local_folder` is true
/// because the shell opens a real native dialog and reopens the library.
///
/// **`can_launch_slicer`, `can_configure_slicers` and `can_browse_model_sites` are false for now.**
/// Desktop part 2 (slicers) and part 3 (the model browser) light them, by flipping the flag here
/// and in [`REMOTE_SHELL_CAPABILITIES`] together: a flag flipped in one column only lights up in
/// one mode, which is why `tests/capabilities.rs` asserts both columns whole.
pub const LOCAL_SHELL_CAPABILITIES: Capabilities = Capabilities {
    requires_auth: false,
    can_manage_users: false,
    can_pick_local_folder: true,
    can_launch_slicer: false,
    can_configure_slicers: false,
    can_browse_model_sites: false,
};

/// The shell's column in **remote server** mode (spec 2.4, third column, shell half).
///
/// One flag differs from the local column and it is the whole reason this is a second constant:
/// `can_pick_local_folder` is false here. It is not a property of the shell (the process can still
/// open a folder dialog and the menu still offers one) but of the *mode*: the library on screen
/// belongs to the server, and a "change library folder" control beside it would swap the whole app
/// to somebody else's library while the page around it still showed remote data.
///
/// The slicer and model-browser flags will be true here as well as locally once parts 2 and 3
/// land: the machine this process runs on has the slicers on it whatever library is open, and a
/// server that cannot launch a slicer must not be able to switch off a shell that can.
pub const REMOTE_SHELL_CAPABILITIES: Capabilities = Capabilities {
    requires_auth: false,
    can_manage_users: false,
    can_pick_local_folder: false,
    can_launch_slicer: false,
    can_configure_slicers: false,
    can_browse_model_sites: false,
};

/// What the web app is told before any library is open: the shell's local column, and nothing
/// from a backend because there is none yet. `requires_auth: false` keeps the page off `/login`
/// (which would be a login against nothing) so the connect page can ask where the library is.
pub const UNSET_SHELL_CAPABILITIES: Capabilities = LOCAL_SHELL_CAPABILITIES;

/// The union of a shell column and a backend column: spec 2.4's "the client uses the union".
///
/// It is `||` on all six, and that is not one rule applied six times. Three different arguments
/// land on the same operator: `requires_auth` is a *restriction*, so the safe combinator is the
/// most restrictive answer (`&&` would let the shell's `false` switch off a login screen while
/// every request still came back 401); `can_manage_users` is only the backend's to offer;
/// `can_pick_local_folder` is the *mode's*, and `||` is right only because the shell column is
/// mode-scoped (over one flat shell column that flag is where a naive union is a defect); and the
/// three slicer and browser flags are the shell's, which a backend must not be able to veto.
pub fn union_capabilities(shell: &Capabilities, backend: &Capabilities) -> Capabilities {
    Capabilities {
        requires_auth: shell.requires_auth || backend.requires_auth,
        can_manage_users: shell.can_manage_users || backend.can_manage_users,
        can_pick_local_folder: shell.can_pick_local_folder || backend.can_pick_local_folder,
        can_launch_slicer: shell.can_launch_slicer || backend.can_launch_slicer,
        can_configure_slicers: shell.can_configure_slicers || backend.can_configure_slicers,
        can_browse_model_sites: shell.can_browse_model_sites || backend.can_browse_model_sites,
    }
}

/// Reads a value off the wire as [`Capabilities`], or `None` if it is not one.
///
/// A remote server is not trusted to be the server we think it is: it may be a proxy's error page,
/// an old build, or an unrelated service on the port the user typed. **Every one of the six keys
/// must be present and boolean.** A partial object would union into `undefined || false` and
/// silently switch off affordances the shell really has; extra keys are tolerated.
pub fn parse_capabilities(value: &Value) -> Option<Capabilities> {
    let object = value.as_object()?;
    let flag = |key: &str| object.get(key)?.as_bool();
    Some(Capabilities {
        requires_auth: flag("requiresAuth")?,
        can_manage_users: flag("canManageUsers")?,
        can_pick_local_folder: flag("canPickLocalFolder")?,
        can_launch_slicer: flag("canLaunchSlicer")?,
        can_configure_slicers: flag("canConfigureSlicers")?,
        can_browse_model_sites: flag("canBrowseModelSites")?,
    })
}
