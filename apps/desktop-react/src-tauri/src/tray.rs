//! 시스템 트레이 상주.
//! - 창 닫기(X) = 트레이로 숨김. 완전한 종료는 트레이 메뉴 "종료" 또는 상단 메뉴의 "종료"만 한다.
//! - 트레이 아이콘 왼쪽 클릭 = 창 열기. 메뉴: 열기, 로그아웃, 연결 상태(표시만), 종료.
//! - 로그아웃·종료는 확인 창(React)을 거쳐야 하므로 창을 연 뒤 프런트엔드에 이벤트(`tray:logout`, `tray:exit`)를 보낸다.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "business-assistant-tray";

pub struct TrayState {
    status: MenuItem<Wry>,
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn status_label(state: &str) -> &'static str {
    match state {
        "online" => "연결됨",
        "offline" => "오프라인",
        _ => "확인 중",
    }
}

/// 서버 연결 상태를 트레이 메뉴와 툴팁에 표시한다(프런트엔드가 상태가 바뀔 때 호출).
pub fn set_status(app: &AppHandle, state: &str) {
    let label = status_label(state);
    if let Some(tray) = app.try_state::<TrayState>() {
        let _ = tray.status.set_text(format!("서버: {label}"));
    }
    if let Some(icon) = app.tray_by_id(TRAY_ID) {
        let _ = icon.set_tooltip(Some(format!("Business Assistant · {label}")));
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
    let logout = MenuItem::with_id(app, "logout", "로그아웃", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "서버: 확인 중", false, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "종료", true, None::<&str>)?;
    let first = PredefinedMenuItem::separator(app)?;
    let second = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &logout, &first, &status, &second, &exit])?;
    app.manage(TrayState { status: status.clone() });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Business Assistant")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "logout" => {
                show_main(app);
                let _ = app.emit_to("main", "tray:logout", ());
            }
            "exit" => {
                show_main(app);
                let _ = app.emit_to("main", "tray:exit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    crate::ba_log!("INFO", "트레이 생성");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::status_label;

    #[test]
    fn labels_connection_states() {
        assert_eq!(status_label("online"), "연결됨");
        assert_eq!(status_label("offline"), "오프라인");
        assert_eq!(status_label("checking"), "확인 중");
        assert_eq!(status_label("anything-else"), "확인 중");
    }
}
