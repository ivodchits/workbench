// The `duck` plugin is the app's own (`lib.rs`), its commands in Kotlin
// (`DuckPlugin.kt`); the page reaches them as `plugin:duck|<command>`.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "duck",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "info", "run", "address", "set_address", "key_create", "key_sign", "key_drop",
                    "token", "set_token", "launch", "reminders", "reminder_actions", "mic_start",
                    "mic_stop", "widget_status", "recognize", "settings", "set_settings",
                    // `addPluginListener`'s, for the plugin's events.
                    "register_listener", "remove_listener",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
