use serde::Serialize;
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig { pub api_base: String, pub storage_host: String }

fn validate_api_base(value: &str, development: bool) -> Result<Url, String> {
    let parsed = Url::parse(value).map_err(|_| "API 주소 형식이 올바르지 않습니다.".to_string())?;
    let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    if parsed.scheme() != "https" && !(development && parsed.scheme() == "http" && local) {
        return Err("배포 API는 HTTPS만 사용할 수 있습니다.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() { return Err("API 기준 주소에 쿼리나 조각을 넣을 수 없습니다.".into()); }
    Ok(parsed)
}

pub fn load() -> Result<AppConfig, String> {
    let development = cfg!(debug_assertions);
    let raw = std::env::var("BUSINESS_ASSISTANT_API_BASE")
        .unwrap_or_else(|_| "http://127.0.0.1:8000/api/v1".into());
    let api = validate_api_base(&raw, development)?;
    let storage_host = std::env::var("BUSINESS_ASSISTANT_STORAGE_HOST").unwrap_or_default().trim().to_lowercase();
    if storage_host.contains('/') || storage_host.contains(':') { return Err("Storage 호스트에는 호스트 이름만 입력해야 합니다.".into()); }
    Ok(AppConfig { api_base: api.as_str().trim_end_matches('/').to_string(), storage_host })
}

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> { load() }

#[cfg(test)]
mod tests {
    use super::validate_api_base;
    #[test] fn permits_local_http_only_in_development() { assert!(validate_api_base("http://127.0.0.1:8000/api/v1", true).is_ok()); assert!(validate_api_base("http://example.com", true).is_err()); }
    #[test] fn permits_https_in_production() { assert!(validate_api_base("https://api.example.com/api/v1", false).is_ok()); assert!(validate_api_base("http://127.0.0.1:8000", false).is_err()); }
}
