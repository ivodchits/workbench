use std::path::Path;

fn main() {
    // The phone's PWA is embedded by `src/remote/server.rs` but built by Vite from
    // `src/pwa/`, and its output is not committed. `npm run dev` / `npm run build`
    // (so `tauri dev` / `tauri build`) produce it first; a bare cargo build on a
    // fresh clone gets told what to run instead of a missing-file error. The office
    // page (office plan O0.2) likewise, from `src/office/`.
    let built = [
        ("src/remote/pwa/dist/index.html", "the phone PWA", "build:pwa"),
        ("src/remote/pwa/dist/sw.js", "the phone PWA", "build:pwa"),
        ("src/remote/office/dist/index.html", "the office page", "build:office"),
    ];
    for (file, what, script) in built {
        let path = Path::new(file);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.exists() {
            panic!(
                "{} is missing: {what} has not been built. \
                 Run `npm run {script}` in the repository root, then build again.",
                path.display()
            );
        }
    }
    tauri_build::build()
}
