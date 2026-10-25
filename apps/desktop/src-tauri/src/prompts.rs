//! The shell's questions, as native dialogs.
//!
//! The dialog plugin is initialised for Rust-side use only: no webview is granted its commands
//! (see [`crate::security`]), so a page cannot pop one of these on its own; the only path to a
//! dialog is an app command the main webview called, or the application menu.

use std::path::PathBuf;

use spm_shell::library::{
    ConfirmOptions, FolderPickerOptions, ModeChoice, ModePickerOptions, PromptTrigger, Prompts,
};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::security::MAIN_WEBVIEW;

pub struct TauriPrompts<R: Runtime> {
    pub app: AppHandle<R>,
}

impl<R: Runtime> TauriPrompts<R> {
    /// A dialog the user raised is modal to the window it was raised from. A startup prompt has
    /// no window to be modal to (or the window is hidden).
    fn parent(&self, trigger: PromptTrigger) -> Option<tauri::WebviewWindow<R>> {
        match trigger {
            PromptTrigger::User => self.app.get_webview_window(MAIN_WEBVIEW),
            PromptTrigger::Startup => None,
        }
    }
}

impl<R: Runtime> Prompts for TauriPrompts<R> {
    fn pick_folder(
        &self,
        options: &FolderPickerOptions,
        trigger: PromptTrigger,
    ) -> Option<PathBuf> {
        let mut dialog = self
            .app
            .dialog()
            .file()
            .set_title(&options.title)
            .set_can_create_directories(options.create_directory);
        if let Some(parent) = self.parent(trigger) {
            dialog = dialog.set_parent(&parent);
        }
        dialog.blocking_pick_folder()?.into_path().ok()
    }

    fn ask_mode(&self, options: &ModePickerOptions) -> ModeChoice {
        let [local, remote, cancel] = options.buttons.clone();
        let result = self
            .app
            .dialog()
            .message(&options.message)
            .title(&options.title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                local.clone(),
                remote.clone(),
                cancel,
            ))
            .blocking_show_with_result();
        match result {
            MessageDialogResult::Custom(label) if label == local => ModeChoice::Local,
            MessageDialogResult::Custom(label) if label == remote => ModeChoice::Remote,
            MessageDialogResult::Yes => ModeChoice::Local,
            MessageDialogResult::No => ModeChoice::Remote,
            _ => ModeChoice::Cancel,
        }
    }

    fn confirm_remote(&self, options: &ConfirmOptions) -> bool {
        let [cancel, connect] = options.buttons.clone();
        self.app
            .dialog()
            .message(format!("{}\n\n{}", options.message, options.detail))
            .title(&options.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(connect, cancel))
            .blocking_show()
    }
}
