fn main() {
    #[cfg(windows)]
    {
        use std::fs;
        use std::path::PathBuf;

        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let original_icon_path = PathBuf::from(&manifest_dir).join("icons/icon.ico");

        let temp_icon_dir = PathBuf::from("C:/Windows/Temp/marcel-ssh-icons");
        fs::create_dir_all(&temp_icon_dir).ok();

        let temp_icon_path = temp_icon_dir.join("icon.ico");

        if original_icon_path.exists() {
            fs::copy(&original_icon_path, &temp_icon_path).ok();
        }

        println!("cargo:rustc-env=ICON_PATH={}", temp_icon_path.display());

        // Activate Common Controls v6 for every artifact (app + unit-test harness).
        // Do NOT embed a full RT_MANIFEST resource here: tauri-build already embeds
        // one for the main binary, and a second MANIFEST (name:1) makes link.exe
        // fail with CVT1100 / LNK1123. /MANIFESTDEPENDENCY only injects the
        // dependency into the linker-generated activation context, which is
        // enough to stop cargo-test exes dying with 0xC0000139
        // (STATUS_ENTRYPOINT_NOT_FOUND) when loading comctl32.
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
