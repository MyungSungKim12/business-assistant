//! Ephemeral caller data is delivered only to our bundled popup, never in a URL or log.
use std::{collections::HashSet, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallPopup {
    id: String, title: String, phone: String, expires_at: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    customers: Vec<CallCustomer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<CallerSummary>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CallCustomer { id: String, name: String }
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct CallerSummary {
    #[serde(skip_serializing_if = "Option::is_none")] notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] allergies: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] last_visit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] treatment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] next_appointment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] photo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] photo_caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] errors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] loading: Option<bool>,
}
fn short(value: &Option<String>, max: usize) -> bool { value.as_ref().is_none_or(|text| text.chars().count() <= max) }
fn valid_summary(summary: &CallerSummary) -> bool {
    short(&summary.notes, 5000) && short(&summary.allergies, 1000) && short(&summary.last_visit, 120)
        && short(&summary.treatment, 300) && short(&summary.next_appointment, 350) && short(&summary.photo_caption, 200)
        && summary.tags.as_ref().is_none_or(|tags| tags.len() <= 8 && tags.iter().all(|tag| tag.chars().count() <= 50))
        && summary.errors.as_ref().is_none_or(|errors| errors.len() <= 5 && errors.iter().all(|error| error.chars().count() <= 80))
        && summary.photo.as_ref().is_none_or(|photo| photo.len() <= 200_000 && photo.strip_prefix("data:image/jpeg;base64,").is_some_and(|base64| !base64.is_empty() && base64.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))))
}
#[derive(Default)]
pub struct PopupState { data: Mutex<PopupData> }
#[derive(Default)]
struct PopupData { calls: Vec<CallPopup>, dismissed: HashSet<String> }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn valid(call: &CallPopup, time: u64) -> bool {
    !call.id.is_empty() && call.id.len() <= 80 && call.title.chars().count() <= 120
        && call.phone.len() <= 40 && call.expires_at > time && call.expires_at <= time + 125_000
        && call.customers.len() <= 10 && call.customers.iter().all(|customer| !customer.id.is_empty() && customer.id.len() <= 80 && customer.name.chars().count() <= 120)
        && call.summary.as_ref().is_none_or(valid_summary)
}
fn check_window(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label { Ok(()) } else { Err("Window not allowed".into()) }
}
pub fn command_allowed(label: &str, command: &str) -> bool {
    label == "main" || (label == "call-popup" && matches!(command, "call_popup_read" | "call_popup_action"))
}

#[tauri::command]
pub async fn call_popup_show(app: AppHandle, window: WebviewWindow, calls: Vec<CallPopup>) -> Result<(), String> {
    check_window(&window, "main")?;
    let time = now();
    if calls.len() > 3 || calls.iter().any(|call| !valid(call, time)) { return Err("Invalid call popup".into()); }
    let (count, enriched) = {
        let state = app.state::<PopupState>();
        let mut data = state.data.lock().map_err(|_| "Popup unavailable")?;
        data.dismissed.retain(|id| calls.iter().any(|call| &call.id == id));
        data.calls = calls.into_iter().filter(|call| !data.dismissed.contains(&call.id)).collect();
        (data.calls.len(), data.calls.iter().any(|call| call.summary.is_some() || call.customers.len() > 1))
    };
    if count == 0 {
        if let Some(popup) = app.get_webview_window("call-popup") { let _ = popup.emit("call-popup:update", ()); let _ = popup.hide(); }
        return Ok(());
    }
    let popup = if let Some(popup) = app.get_webview_window("call-popup") { popup } else {
        WebviewWindowBuilder::new(&app, "call-popup", WebviewUrl::App("call-popup.html".into()))
            .title("고객 전화 수신").inner_size(380.0, 210.0).decorations(false).resizable(false)
            .always_on_top(true).skip_taskbar(true).focused(false).visible(false)
            .build().map_err(|e| e.to_string())?
    };
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())?.or(app.primary_monitor().map_err(|e| e.to_string())?) {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (420.0 * scale).min(area.size.width as f64);
        let height = ((count as f64 * if enriched { 460.0 } else { 204.0 } + 28.0) * scale).min((area.size.height as f64 - 32.0 * scale).max(180.0));
        popup.set_size(tauri::PhysicalSize::new(width as u32, height as u32)).map_err(|e| e.to_string())?;
        popup.set_position(tauri::PhysicalPosition::new(
            area.position.x + (area.size.width as f64 - width - 16.0 * scale).max(0.0) as i32,
            area.position.y + (area.size.height as f64 - height - 16.0 * scale).max(0.0) as i32,
        )).map_err(|e| e.to_string())?;
    }
    // Do not steal focus from an editor or another app when a call arrives.
    popup.emit("call-popup:update", ()).map_err(|e| e.to_string())?;
    popup.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn call_popup_read(app: AppHandle, window: WebviewWindow) -> Result<Vec<CallPopup>, String> {
    check_window(&window, "call-popup")?;
    let state = app.state::<PopupState>();
    let mut data = state.data.lock().map_err(|_| "Popup unavailable")?;
    data.calls.retain(|call| call.expires_at > now());
    if data.calls.is_empty() { let _ = window.hide(); }
    Ok(data.calls.clone())
}

#[tauri::command]
pub fn call_popup_action(app: AppHandle, window: WebviewWindow, id: String, memo: bool, action: Option<String>, customer_id: Option<String>) -> Result<(), String> {
    check_window(&window, "call-popup")?;
    {
        let state = app.state::<PopupState>();
        let mut data = state.data.lock().map_err(|_| "Popup unavailable")?;
        let call = data.calls.iter().find(|call| call.id == id && call.expires_at > now()).ok_or("Call expired")?;
        if action.as_deref() == Some("retry") { return app.emit_to("main", "call-popup:retry", id).map_err(|e| e.to_string()); }
        if action.as_deref() == Some("customer") {
            if !call.customers.iter().any(|customer| Some(&customer.id) == customer_id.as_ref()) { return Err("Customer not matched".into()); }
        } else if action.is_some() { return Err("Invalid call action".into()); }
        if action.is_none() && !memo {
            data.calls.retain(|call| call.id != id);
            data.dismissed.insert(id.clone());
            if data.calls.is_empty() { let _ = window.hide(); }
        }
    }
    window.emit("call-popup:update", ()).map_err(|e| e.to_string())?;
    if action.as_deref() == Some("customer") {
        crate::tray::show_main(&app);
        app.emit_to("main", "call-popup:customer", serde_json::json!({ "id": id, "customerId": customer_id })).map_err(|e| e.to_string())?;
    } else if memo { crate::tray::show_main(&app); app.emit_to("main", "call-popup:memo", id).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Only the main window can confirm that navigation or the memo dialog succeeded.
#[tauri::command]
pub fn call_popup_ack(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    check_window(&window, "main")?;
    let state = app.state::<PopupState>();
    let mut data = state.data.lock().map_err(|_| "Popup unavailable")?;
    if !data.calls.iter().any(|call| call.id == id && call.expires_at > now()) { return Err("Call expired".into()); }
    data.calls.retain(|call| call.id != id);
    data.dismissed.insert(id);
    if let Some(popup) = app.get_webview_window("call-popup") {
        if data.calls.is_empty() { let _ = popup.hide(); }
        popup.emit("call-popup:update", ()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn popup_has_no_credentials_http_file_or_update_access() {
        assert!(command_allowed("call-popup", "call_popup_read"));
        assert!(command_allowed("call-popup", "call_popup_action"));
        for command in ["token_load", "token_save", "http_request", "pick_files", "app_exit", "update_install", "call_popup_show", "call_popup_ack"] {
            assert!(!command_allowed("call-popup", command));
            assert!(command_allowed("main", command));
        }
        assert!(!command_allowed("other", "call_popup_read"));
    }
    #[test]
    fn rejects_expired_oversized_and_far_future_calls() {
        let mut call = CallPopup { id: "id".into(), title: "고객".into(), phone: "+827012345678".into(), expires_at: 121_000, customers: vec![], summary: None };
        assert!(valid(&call, 1_000));
        assert!(!valid(&call, 121_000));
        call.expires_at = 200_000; assert!(!valid(&call, 1_000));
        call.expires_at = 121_000; call.title = "가".repeat(121); assert!(!valid(&call, 1_000));
    }
    #[test]
    fn limits_customer_summary_and_accepts_only_bounded_raster_previews() {
        let mut summary = CallerSummary { notes: Some("응대 메모".into()), photo: Some("data:image/jpeg;base64,/9j/AA==".into()), ..Default::default() };
        assert!(valid_summary(&summary));
        summary.photo = Some("https://example.com/customer.jpg".into()); assert!(!valid_summary(&summary));
        summary.photo = Some("data:image/svg+xml;base64,AA==".into()); assert!(!valid_summary(&summary));
        summary.photo = None; summary.notes = Some("가".repeat(5001)); assert!(!valid_summary(&summary));
        summary.notes = None; summary.tags = Some(vec!["태그".into(); 9]); assert!(!valid_summary(&summary));
    }
}
