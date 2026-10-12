mod config;
mod credentials;
mod files;
mod http;

use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> { app.autolaunch().is_enabled().map_err(|e| e.to_string()) }

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() }.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            config::get_config, http::http_request, credentials::token_load, credentials::token_save,
            credentials::token_clear, files::pick_images, files::upload_binary, files::download_binary,
            autostart_is_enabled, autostart_set
        ])
        .run(tauri::generate_context!())
        .expect("Business Assistant 실행에 실패했습니다.");
}
