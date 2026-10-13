use serde::Serialize;
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig { pub api_base: String, pub admin_api_base: String, pub storage_host: String }

fn validate_api_base(value: &str, development: bool) -> Result<Url, String> {
    let parsed = Url::parse(value).map_err(|_| "API 주소 형식이 올바르지 않습니다.".to_string())?;
    let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    if parsed.scheme() != "https" && !(development && parsed.scheme() == "http" && local) {
        return Err("배포 API는 HTTPS만 사용할 수 있습니다.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() { return Err("API 기준 주소에 쿼리나 조각을 넣을 수 없습니다.".into()); }
    Ok(parsed)
}

/// 관리자 API 기본 주소: 로컬 개발이면 같은 호스트의 8001 포트, 그 밖에는 설정하지 않으면 비어 있다(관리자 기능 사용 불가).
fn default_admin_base(api: &Url) -> String {
    let local = matches!(api.host_str(), Some("127.0.0.1" | "localhost"));
    if !local { return String::new(); }
    let mut admin = api.clone();
    let _ = admin.set_port(Some(8001));
    admin.as_str().trim_end_matches('/').to_string()
}

/// 빌드할 때 박아 넣는 기본값. 설치본을 만드는 릴리스 워크플로가 환경변수로 넘기며, 설치된 앱은 이 값을 서버 주소로 쓴다.
const BUILT_IN_API_BASE: Option<&str> = option_env!("BUSINESS_ASSISTANT_API_BASE_DEFAULT");
const BUILT_IN_ADMIN_API_BASE: Option<&str> = option_env!("BUSINESS_ASSISTANT_ADMIN_API_BASE_DEFAULT");
const BUILT_IN_STORAGE_HOST: Option<&str> = option_env!("BUSINESS_ASSISTANT_STORAGE_HOST_DEFAULT");

/// 서버 주소 결정 순서: 실행 환경변수 → 빌드에 박은 기본값 → (개발 빌드에서만) 로컬 주소.
/// 배포 빌드에서 둘 다 없으면 안내 오류를 낸다(설치본이 엉뚱한 주소를 쓰지 않게).
fn resolve_api_base(runtime: Option<String>, built_in: Option<&str>, development: bool) -> Result<String, String> {
    if let Some(value) = runtime.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) { return Ok(value); }
    if let Some(value) = built_in.map(str::trim).filter(|v| !v.is_empty()) { return Ok(value.to_string()); }
    if development { return Ok("http://127.0.0.1:8000/api/v1".into()); }
    Err("서버 주소가 설정되지 않았습니다. 설치 파일을 만들 때 BUSINESS_ASSISTANT_API_BASE_DEFAULT를 지정하거나, 실행 환경에 BUSINESS_ASSISTANT_API_BASE를 설정하세요.".into())
}

pub fn load() -> Result<AppConfig, String> {
    let development = cfg!(debug_assertions);
    let raw = resolve_api_base(std::env::var("BUSINESS_ASSISTANT_API_BASE").ok(), BUILT_IN_API_BASE, development)?;
    let api = validate_api_base(&raw, development)?;
    let storage_host = std::env::var("BUSINESS_ASSISTANT_STORAGE_HOST").ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| BUILT_IN_STORAGE_HOST.map(str::to_string))
        .unwrap_or_default().trim().to_lowercase();
    if storage_host.contains('/') || storage_host.contains(':') { return Err("Storage 호스트에는 호스트 이름만 입력해야 합니다.".into()); }
    let api_base = api.as_str().trim_end_matches('/').to_string();
    let admin_raw = std::env::var("BUSINESS_ASSISTANT_ADMIN_API_BASE").ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| BUILT_IN_ADMIN_API_BASE.map(str::to_string));
    let admin_api_base = match admin_raw {
        Some(value) => validate_api_base(value.trim(), development)?.as_str().trim_end_matches('/').to_string(),
        None => default_admin_base(&api),
    };
    Ok(AppConfig { api_base, admin_api_base, storage_host })
}

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> { load() }

#[cfg(test)]
mod tests {
    use super::{default_admin_base, resolve_api_base, validate_api_base};
    use url::Url;
    #[test] fn permits_local_http_only_in_development() { assert!(validate_api_base("http://127.0.0.1:8000/api/v1", true).is_ok()); assert!(validate_api_base("http://example.com", true).is_err()); }
    #[test] fn derives_the_local_admin_api_base_only_for_local_hosts() {
        assert_eq!(default_admin_base(&Url::parse("http://127.0.0.1:8000/api/v1").unwrap()), "http://127.0.0.1:8001/api/v1");
        assert_eq!(default_admin_base(&Url::parse("https://api.example.com/api/v1").unwrap()), "");
    }
    #[test] fn api_base_prefers_runtime_then_built_in_then_development_default() {
        assert_eq!(resolve_api_base(Some(" https://run.example.com/api/v1 ".into()), Some("https://built.example.com/api/v1"), false).unwrap(), "https://run.example.com/api/v1");
        assert_eq!(resolve_api_base(None, Some("https://built.example.com/api/v1"), false).unwrap(), "https://built.example.com/api/v1");
        assert_eq!(resolve_api_base(Some("  ".into()), None, true).unwrap(), "http://127.0.0.1:8000/api/v1");
    }
    #[test] fn release_build_without_any_server_address_is_an_error() {
        let message = resolve_api_base(None, None, false).unwrap_err();
        assert!(message.contains("BUSINESS_ASSISTANT_API_BASE"));
        assert!(resolve_api_base(None, Some(""), false).is_err());
    }
    #[test] fn permits_https_in_production() { assert!(validate_api_base("https://api.example.com/api/v1", false).is_ok()); assert!(validate_api_base("http://127.0.0.1:8000", false).is_err()); }
}
