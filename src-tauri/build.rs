use std::path::Path;

fn main() {
    // The phone's PWA is embedded by `src/remote/server.rs` but built by Vite from
    // `src/pwa/`, and its output is not committed. `npm run dev` / `npm run build`
    // (so `tauri dev` / `tauri build`) produce it first; a bare cargo build on a
    // fresh clone gets told what to run instead of a missing-file error.
    for file in ["index.html", "sw.js"] {
        let path = Path::new("src/remote/pwa/dist").join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.exists() {
            panic!(
                "{} is missing: the phone PWA has not been built. \
                 Run `npm run build:pwa` in the repository root, then build again.",
                path.display()
            );
        }
    }
    tauri_build::build()
}
