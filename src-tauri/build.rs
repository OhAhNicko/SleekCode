fn main() {
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=dwmapi");
        println!("cargo:rustc-link-lib=comctl32");
    }

    tauri_build::build()
}
