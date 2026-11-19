// No extra console window for the release build on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(err) = brisa_lib::run() {
        eprintln!("brisa: {err}");
        std::process::exit(1);
    }
}
