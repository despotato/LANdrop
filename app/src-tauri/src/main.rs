#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      commands::save_to_downloads,
      commands::discover_signaling,
      commands::ensure_signaling
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
