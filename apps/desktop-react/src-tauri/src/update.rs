//! 자동 업데이트 (OPS-02). tauri-plugin-updater + minisign 서명 검증.
//!
//! 설정(사용자가 채우는 값)
//! - 엔드포인트: 환경변수 `BUSINESS_ASSISTANT_UPDATE_ENDPOINT`(실행 시) > 같은 이름의 빌드 시 환경변수 >
//!   `tauri.conf.json` 의 `plugins.updater.endpoints[0]`. 모두 비어 있으면 "미설정"이다.
//! - 공개키: `plugins.updater.pubkey`. 자리표시자(`REPLACE_WITH_UPDATER_PUBLIC_KEY`)이거나 비어 있으면 업데이트 기능은 비활성이다.
//! - 운영(release) 빌드는 HTTPS 주소만 허용한다. 로컬 http(127.0.0.1·localhost)는 debug 빌드에서만 허용한다.
//!
//! 미설정이어도 앱은 정상 시작한다(`update_check` 가 `{configured:false}` 를 돌려줄 뿐이다).
//! 시작 직후에는 확인하지 않고, 앱 설정 파일에서 자동 확인이 켜져 있을 때 시작 30초 뒤 한 번 확인한다.
//! 환경변수 `BUSINESS_ASSISTANT_UPDATE_AUTOCHECK=0` 은 설정 파일보다 우선해 자동 확인을 끈다.
//! 새 버전이 있으면 `update:available` 이벤트를 발행한다. UI에서 끄면 대기 중인 확인도 건너뛴다.
//!
//! 검증: 설정 판정 함수는 cargo test 로 확인한다. 실제 다운로드·서명 검증·설치·재시작은 서명 키와 업데이트 서버가
//! 준비된 뒤에 확인해야 한다(이 저장소에서는 실행하지 않았다).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

/// tauri.conf.json 에 들어 있는 공개키 자리표시자
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";
const ENDPOINT_ENV: &str = "BUSINESS_ASSISTANT_UPDATE_ENDPOINT";
const AUTOCHECK_ENV: &str = "BUSINESS_ASSISTANT_UPDATE_AUTOCHECK";
const AUTOCHECK_FILE: &str = "update-autocheck";
const AUTOCHECK_DELAY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct UpdateState(pub Mutex<Option<Update>>);
pub struct AutoCheckState(AtomicBool);

fn autocheck_allowed_by_environment() -> bool {
    !std::env::var(AUTOCHECK_ENV).map(|v| v.trim() == "0").unwrap_or(false)
}

fn autocheck_preference_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join(AUTOCHECK_FILE)).map_err(|e| format!("업데이트 설정 경로를 찾지 못했습니다: {e}"))
}

fn load_autocheck_preference(path: &Path) -> bool {
    match fs::read_to_string(path).unwrap_or_default().trim() {
        "false" | "0" | "off" => false,
        _ => true,
    }
}

fn save_autocheck_preference(path: &Path, enabled: bool) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "업데이트 설정 경로가 올바르지 않습니다.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("업데이트 설정 폴더를 만들지 못했습니다: {e}"))?;
    fs::write(path, if enabled { "true" } else { "false" }).map_err(|e| format!("업데이트 설정을 저장하지 못했습니다: {e}"))
}

#[tauri::command]
pub fn update_autocheck_get(app: AppHandle) -> Result<bool, String> {
    Ok(load_autocheck_preference(&autocheck_preference_path(&app)?))
}

#[tauri::command]
pub fn update_autocheck_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    save_autocheck_preference(&autocheck_preference_path(&app)?, enabled)?;
    app.state::<AutoCheckState>().0.store(enabled && autocheck_allowed_by_environment(), Ordering::Relaxed);
    Ok(())
}

/// 업데이트를 쓸 수 없는 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotConfigured {
    /// 업데이트 서버 주소가 비어 있다
    Endpoint,
    /// 서명 공개키가 없거나 자리표시자 그대로다
    Pubkey,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub configured: bool,
    pub current_version: String,
    pub reason: Option<NotConfigured>,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

pub struct Settings {
    pub endpoint: Url,
    pub pubkey: String,
}

/// 공개키가 비었거나 자리표시자이면 true
pub fn is_placeholder_pubkey(pubkey: &str) -> bool {
    let p = pubkey.trim();
    p.is_empty() || p.contains(PUBKEY_PLACEHOLDER)
}

/// 환경변수 값과 설정 파일 값 중 쓸 엔드포인트를 고른다. 공백뿐인 값은 없는 것으로 본다
pub fn pick_endpoint(env_runtime: Option<&str>, env_build: Option<&str>, conf: &[String]) -> Option<String> {
    let clean = |v: &str| {
        let t = v.trim();
        (!t.is_empty()).then(|| t.to_string())
    };
    env_runtime
        .and_then(clean)
        .or_else(|| env_build.and_then(clean))
        .or_else(|| conf.iter().find_map(|v| clean(v)))
}

/// 엔드포인트 검증: HTTPS 만. 로컬 http 는 debug 빌드에서만. (템플릿 `{{target}}` 등은 그대로 허용)
pub fn validate_endpoint(raw: &str, release_build: bool) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "업데이트 서버 주소 형식이 올바르지 않습니다.".to_string())?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    let ok = url.scheme() == "https" || (!release_build && url.scheme() == "http" && local);
    if !ok {
        return Err("업데이트 서버는 HTTPS 주소만 사용할 수 있습니다.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("업데이트 서버 주소에 계정 정보를 넣을 수 없습니다.".into());
    }
    Ok(url)
}

/// 설정을 종합 판정한다. Ok(Err(이유)) = 미설정(정상 상태), Err(메시지) = 잘못된 설정
pub fn resolve(
    pubkey: &str,
    env_runtime: Option<&str>,
    env_build: Option<&str>,
    conf_endpoints: &[String],
    release_build: bool,
) -> Result<Result<Settings, NotConfigured>, String> {
    let Some(raw) = pick_endpoint(env_runtime, env_build, conf_endpoints) else {
        return Ok(Err(NotConfigured::Endpoint));
    };
    if is_placeholder_pubkey(pubkey) {
        return Ok(Err(NotConfigured::Pubkey));
    }
    let endpoint = validate_endpoint(&raw, release_build)?;
    Ok(Ok(Settings { endpoint, pubkey: pubkey.trim().to_string() }))
}

fn load_settings(app: &AppHandle) -> Result<Result<Settings, NotConfigured>, String> {
    let conf = app.config().plugins.0.get("updater");
    let pubkey = conf.and_then(|c| c.get("pubkey")).and_then(|v| v.as_str()).unwrap_or("");
    let endpoints: Vec<String> = conf
        .and_then(|c| c.get("endpoints"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let runtime = std::env::var(ENDPOINT_ENV).ok();
    resolve(pubkey, runtime.as_deref(), option_env!("BUSINESS_ASSISTANT_UPDATE_ENDPOINT"), &endpoints, !cfg!(debug_assertions))
}

async fn check_inner(app: &AppHandle, state: &UpdateState) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let settings = match load_settings(app)? {
        Ok(s) => s,
        Err(reason) => return Ok(UpdateCheck { configured: false, current_version, reason: Some(reason), ..Default::default() }),
    };
    let updater = app
        .updater_builder()
        .pubkey(settings.pubkey)
        .endpoints(vec![settings.endpoint])
        .map_err(|e| format!("업데이트 설정 오류: {e}"))?
        .build()
        .map_err(|e| format!("업데이트 설정 오류: {e}"))?;
    ba_log!("INFO", "업데이트 확인 시작 (현재 {current_version})");
    let found = updater.check().await.map_err(|e| {
        ba_log!("WARN", "업데이트 확인 실패: {e}");
        format!("업데이트 확인에 실패했습니다: {e}")
    })?;
    let result = UpdateCheck {
        configured: true,
        current_version,
        available: found.is_some(),
        version: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()),
        date: found.as_ref().and_then(|u| u.date.map(|d| d.to_string())),
        reason: None,
    };
    match &result.version {
        Some(v) => ba_log!("INFO", "새 버전 {v} 있음"),
        None => ba_log!("INFO", "최신 버전입니다."),
    }
    *state.0.lock().map_err(|e| e.to_string())? = found;
    Ok(result)
}

/// 새 버전이 있는지 확인한다. 서버·공개키가 미설정이면 오류가 아니라 `configured:false` 를 돌려준다
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<UpdateCheck, String> {
    check_inner(&app, &state).await
}

/// 확인한 업데이트를 내려받아 설치한다(서명 검증 실패면 오류). 설치 뒤 앱을 재시작한다
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let update = state.0.lock().map_err(|e| e.to_string())?.take().ok_or("먼저 업데이트를 확인하세요.")?;
    let handle = app.clone();
    let mut downloaded: u64 = 0;
    ba_log!("INFO", "업데이트 설치 시작 {}", update.version);
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = handle.emit("update:progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| {
            ba_log!("ERROR", "업데이트 설치 실패: {e}");
            format!("업데이트 설치에 실패했습니다: {e}")
        })?;
    // Windows(NSIS)는 설치 프로그램이 앱을 닫는다. 그렇지 않은 경우를 위해 재시작한다
    app.restart();
}

/// 상태를 등록하고, 설정되어 있으면 시작 30초 뒤 한 번 백그라운드로 확인한다
pub fn setup(app: &AppHandle) {
    app.manage(UpdateState::default());
    let preference_enabled = autocheck_preference_path(app).map(|path| load_autocheck_preference(&path)).unwrap_or(true);
    let enabled_at_start = preference_enabled && autocheck_allowed_by_environment();
    app.manage(AutoCheckState(AtomicBool::new(enabled_at_start)));
    if !enabled_at_start {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(AUTOCHECK_DELAY);
        if !handle.state::<AutoCheckState>().0.load(Ordering::Relaxed) {
            ba_log!("INFO", "사용자 설정으로 자동 업데이트 확인을 건너뜁니다.");
            return;
        }
        if !matches!(load_settings(&handle), Ok(Ok(_))) {
            return;
        }
        let state = handle.state::<UpdateState>();
        if let Ok(result) = tauri::async_runtime::block_on(check_inner(&handle, &state)) {
            if result.available {
                let _ = handle.emit("update:available", result);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=";

    #[test]
    fn automatic_check_preference_defaults_to_enabled_and_persists_opt_out() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("ba-update-preference-{}-{unique}", std::process::id()));
        let file = dir.join("update-autocheck");

        assert!(load_autocheck_preference(&file));
        save_autocheck_preference(&file, false).unwrap();
        assert!(!load_autocheck_preference(&file));
        save_autocheck_preference(&file, true).unwrap();
        assert!(load_autocheck_preference(&file));

        let _ = std::fs::remove_dir_all(Path::new(&dir));
    }

    #[test]
    fn detects_placeholder_pubkey() {
        assert!(is_placeholder_pubkey(PUBKEY_PLACEHOLDER));
        assert!(is_placeholder_pubkey("  "));
        assert!(is_placeholder_pubkey(""));
        assert!(!is_placeholder_pubkey(KEY));
    }

    #[test]
    fn picks_endpoint_in_priority_order_and_ignores_blank() {
        let conf = vec!["https://conf.example.com/latest.json".to_string()];
        assert_eq!(pick_endpoint(Some("https://env.example.com/a"), None, &conf).as_deref(), Some("https://env.example.com/a"));
        assert_eq!(pick_endpoint(Some("  "), Some("https://build.example.com/a"), &conf).as_deref(), Some("https://build.example.com/a"));
        assert_eq!(pick_endpoint(None, None, &conf).as_deref(), Some("https://conf.example.com/latest.json"));
        assert_eq!(pick_endpoint(None, None, &[]), None);
        assert_eq!(pick_endpoint(Some(""), Some(" "), &["".to_string()]), None);
    }

    #[test]
    fn enforces_https_and_local_http_only_in_debug() {
        assert!(validate_endpoint("https://updates.example.com/{{target}}/{{arch}}/{{current_version}}", true).is_ok());
        assert!(validate_endpoint("http://updates.example.com/latest.json", false).is_err());
        assert!(validate_endpoint("http://127.0.0.1:8787/latest.json", false).is_ok());
        assert!(validate_endpoint("http://localhost:8787/latest.json", false).is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8787/latest.json", true).is_err());
        assert!(validate_endpoint("ftp://example.com/x", false).is_err());
        assert!(validate_endpoint("https://user:pw@example.com/x", true).is_err());
        assert!(validate_endpoint("not a url", true).is_err());
    }

    #[test]
    fn empty_endpoint_means_not_configured() {
        assert!(matches!(resolve(KEY, None, None, &[], true), Ok(Err(NotConfigured::Endpoint))));
        // 엔드포인트가 비어 있으면 공개키가 자리표시자여도 "서버 미설정"으로 먼저 안내한다
        assert!(matches!(resolve(PUBKEY_PLACEHOLDER, None, None, &[], true), Ok(Err(NotConfigured::Endpoint))));
    }

    #[test]
    fn placeholder_pubkey_disables_updates_without_error() {
        let r = resolve(PUBKEY_PLACEHOLDER, Some("https://u.example.com/latest.json"), None, &[], true);
        assert!(matches!(r, Ok(Err(NotConfigured::Pubkey))));
    }

    #[test]
    fn configured_when_key_and_https_endpoint_present() {
        let r = resolve(KEY, Some("https://u.example.com/latest.json"), None, &[], true).unwrap();
        let s = r.ok().expect("configured");
        assert_eq!(s.endpoint.as_str(), "https://u.example.com/latest.json");
        assert_eq!(s.pubkey, KEY);
    }

    #[test]
    fn insecure_endpoint_is_an_error_in_release() {
        assert!(resolve(KEY, Some("http://u.example.com/latest.json"), None, &[], true).is_err());
    }
}
