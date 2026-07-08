fn main() {
    // Link AVFoundation so AVCaptureDevice (microphone TCC status + prompt) is
    // registered in the ObjC runtime at launch.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    tauri_build::build()
}
