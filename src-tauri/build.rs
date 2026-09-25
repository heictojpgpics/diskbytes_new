//! Tauri build script: generates the `WebView` context + Windows
//! resources (icons) declared in `tauri.conf.json` and `capabilities/`.
//!
//! The application MANIFEST is supplied by the LINKER, not the resource
//! compiler, so that TEST binaries receive it too — see the windows
//! block below (the STATUS_ENTRYPOINT_NOT_FOUND / TaskDialogIndirect
//! fix, tauri issue #13419's official workaround).

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");

    // `cargo test` on Windows fails to LOAD the unit-test exe with
    // STATUS_ENTRYPOINT_NOT_FOUND: code linked into the test binary
    // (tauri's windowing stack) imports TaskDialogIndirect, which only
    // exists in the comctl32 v6 side-by-side assembly — and tauri's
    // resource-embedded manifest lands in the app BIN only, while
    // cargo has no link-arg directive scoped to the lib's unit-test
    // harness (`rustc-link-arg-tests` covers tests/*.rs targets only).
    // Supplying the manifest for ALL targets via the linker is the
    // official pattern (tauri's examples/api/src-tauri/build.rs).
    #[cfg(windows)]
    {
        let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
        if target_os == "windows" && target_env == "msvc" {
            let manifest = std::env::current_dir()
                .expect("build script cwd")
                .join("windows-app-manifest.xml");
            println!("cargo:rerun-if-changed={}", manifest.display());
            // Embed the Windows application manifest file.
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!(
                "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
                manifest.to_str().expect("utf-8 manifest path")
            );
        }
    }
}
