use std::collections::HashMap;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use url::Url;
use crate::config;

#[derive(Deserialize)]
pub struct NativeHttpRequest { method: String, path: String, headers: HashMap<String, String>, body: Option<String> }

#[derive(Serialize)]
pub struct NativeHttpResponse { status: u16, body: String, headers: HashMap<String, String> }

fn api_url(base: &str, path: &str) -> Result<Url, String> {
    if path.contains("..") || path.starts_with("//") || Url::parse(path).is_ok() { return Err("API 경로가 허용 범위를 벗어났습니다.".into()); }
    let mut url = Url::parse(&format!("{}/", base.trim_end_matches('/'))).map_err(|_| "API 기준 주소가 잘못되었습니다.".to_string())?;
    // 쿼리(?a=b)는 경로에 넣으면 %3F로 인코딩되어 서버가 경로를 찾지 못한다. 경로와 쿼리를 나눠 넣는다.
    let (route, query) = match path.split_once('?') { Some((route, query)) => (route, Some(query)), None => (path, None) };
    if route.contains('#') || query.is_some_and(|q| q.contains('#')) { return Err("API 경로가 허용 범위를 벗어났습니다.".into()); }
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), route.trim_start_matches('/')));
    url.set_query(query.filter(|q| !q.is_empty()));
    Ok(url)
}

/// 서명 URL은 HTTPS이며 허용된 호스트여야 한다. BUSINESS_ASSISTANT_STORAGE_HOST가 있으면 그 호스트만, 없으면 Supabase Storage(*.supabase.co)만 허용한다.
pub fn signed_url(raw: &str, allowed_host: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "서명 URL 형식이 올바르지 않습니다.".to_string())?;
    if url.scheme() != "https" { return Err("허용되지 않은 Storage 주소입니다. HTTPS 주소만 사용할 수 있습니다.".into()); }
    let host = url.host_str().map(str::to_lowercase).unwrap_or_default();
    let allowed = if allowed_host.is_empty() { host.ends_with(".supabase.co") } else { host == allowed_host };
    if !allowed { return Err(format!("허용되지 않은 Storage 주소입니다. ({host}) BUSINESS_ASSISTANT_STORAGE_HOST 설정을 확인하세요.")); }
    Ok(url)
}

#[tauri::command]
pub async fn http_request(request: NativeHttpRequest) -> Result<NativeHttpResponse, String> {
    let cfg = config::load()?;
    let url = api_url(&cfg.api_base, &request.path)?;
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| "지원하지 않는 HTTP 방식입니다.".to_string())?;
    let client = Client::builder().build().map_err(|e| e.to_string())?;
    let mut builder = client.request(method, url);
    for (name, value) in request.headers { builder = builder.header(name, value); }
    if let Some(body) = request.body { builder = builder.body(body); }
    let response = builder.send().await.map_err(|e| format!("서버에 연결하지 못했습니다: {e}"))?;
    let status = response.status().as_u16();
    let headers = response.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string()))).collect();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(NativeHttpResponse { status, body, headers })
}

#[cfg(test)]
mod tests {
    use super::{api_url, signed_url};
    #[test] fn rejects_external_and_parent_api_paths() { assert!(api_url("https://api.example.com/api/v1", "https://evil.test").is_err()); assert!(api_url("https://api.example.com/api/v1", "../admin").is_err()); }
    #[test] fn keeps_query_strings_out_of_the_path() {
        let url = api_url("http://127.0.0.1:8000/api/v1", "/organizations/o1/appointments?from_date=2026-10-12&to_date=2026-10-14").unwrap();
        assert_eq!(url.path(), "/api/v1/organizations/o1/appointments");
        assert_eq!(url.query(), Some("from_date=2026-10-12&to_date=2026-10-14"));
        assert_eq!(api_url("http://127.0.0.1:8000/api/v1", "/me").unwrap().query(), None);
        assert!(api_url("http://127.0.0.1:8000/api/v1", "/me#frag").is_err());
    }
    #[test] fn defaults_to_supabase_storage_when_no_host_is_configured() {
        assert!(signed_url("https://abc.supabase.co/storage/v1/object/upload/sign/x", "").is_ok());
        assert!(signed_url("https://evil.test/a", "").is_err());
        assert!(signed_url("https://supabase.co.evil.test/a", "").is_err());
        assert!(signed_url("http://abc.supabase.co/a", "").is_err());
    }
    #[test] fn allows_only_configured_https_storage_host() { assert!(signed_url("https://store.example.com/object/a", "store.example.com").is_ok()); assert!(signed_url("http://store.example.com/a", "store.example.com").is_err()); assert!(signed_url("https://evil.test/a", "store.example.com").is_err()); }
}
