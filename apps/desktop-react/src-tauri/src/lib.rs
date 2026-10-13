mod config;
mod credentials;
mod files;
mod http;
#[macro_use]
mod logfile;

use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// 자동 시작 때 넘기는 인자. 이 인자로 시작하면 창을 최소화한 채 연다.
const START_MINIMIZED_ARG: &str = "--minimized";
/// 프런트엔드가 준비 신호를 못 보낼 때를 대비한 최대 대기 시간
const SHOW_FALLBACK: Duration = Duration::from_secs(12);

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 첫 화면이 그려진 뒤 프런트엔드가 호출한다. 흰 화면 깜빡임 없이 창을 연다.
#[tauri::command]
fn show_main(app: AppHandle) {
    if std::env::args().any(|arg| arg == START_MINIMIZED_ARG) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
            let _ = window.show();
        }
        return;
    }
    show_window(&app);
}

#[tauri::command]
fn app_exit(app: AppHandle) {
    ba_log!("INFO", "종료 요청");
    app.exit(0);
}

#[tauri::command]
fn autostart_is_enabled(app: AppHandle) -> Result<bool, String> { app.autolaunch().is_enabled().map_err(|e| e.to_string()) }

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() }.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            ba_log!("INFO", "두 번째 실행 감지: 기존 창을 앞으로 가져옵니다.");
            show_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE).build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![START_MINIMIZED_ARG])))
        .setup(|app| {
            let note = logfile::init(app.handle());
            ba_log!("INFO", "Business Assistant {} 시작, 로그 폴더 {note}", env!("CARGO_PKG_VERSION"));
            match config::load() {
                Ok(c) => ba_log!("INFO", "API 기준 주소 {} (debug 빌드 {})", c.api_base, cfg!(debug_assertions)),
                Err(e) => ba_log!("ERROR", "설정 오류: {e}"),
            }
            // 프런트엔드 준비 신호가 오지 않아도 창은 결국 열려야 오류 안내를 볼 수 있다.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        ba_log!("WARN", "준비 신호가 없어 창을 강제로 표시합니다.");
                        show_main(handle.clone());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config, http::http_request, credentials::token_load, credentials::token_save,
            credentials::token_clear, files::pick_images, files::pick_files, files::upload_binary, files::download_binary,
            autostart_is_enabled, autostart_set, show_main, app_exit, logfile::log_write
        ])
        .run(tauri::generate_context!())
        .expect("Business Assistant 실행에 실패했습니다.");
}
