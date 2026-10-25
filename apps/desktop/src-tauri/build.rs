#[path = "src/app_commands.rs"]
mod app_commands;

fn main() {
    // Registering the app's own commands in an app manifest is what turns "every command is
    // callable by every webview" (Tauri's default for app commands) into "a command is callable
    // only where a capability names its permission". See `src/app_commands.rs`.
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(app_commands::APP_COMMANDS));
    tauri_build::try_build(attributes).expect("the Tauri build step failed");
}
