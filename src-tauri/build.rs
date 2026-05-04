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
    }
    
    tauri_build::build()
}
