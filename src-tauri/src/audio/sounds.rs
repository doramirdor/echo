use std::process::Command;

fn play_system_sound(name: &str) {
    let path = format!("/System/Library/Sounds/{}.aiff", name);
    let _ = Command::new("afplay").arg(&path).spawn();
}

pub fn play_recording_start() {
    play_system_sound("Tink");
}

pub fn play_recording_stop() {
    play_system_sound("Pop");
}

pub fn play_error() {
    play_system_sound("Basso");
}

pub fn play_success() {
    play_system_sound("Glass");
}
