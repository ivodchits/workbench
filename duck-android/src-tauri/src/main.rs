// The desktop build only exists so the crate builds everywhere; Duck's app is
// the Android one (`lib.rs`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    duck_android_lib::run()
}
