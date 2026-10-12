const SERVICE: &str = "business-assistant";
const ACCOUNT: &str = "refresh-token";

fn entry() -> Result<keyring::Entry, String> { keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string()) }

#[tauri::command]
pub fn token_load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn token_save(refresh_token: String) -> Result<(), String> {
    if refresh_token.trim().is_empty() { return Err("빈 토큰은 저장할 수 없습니다.".into()); }
    entry()?.set_password(&refresh_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn token_clear() -> Result<(), String> {
    match entry()?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(error) => Err(error.to_string()) }
}

#[cfg(test)]
mod tests { use super::{ACCOUNT, SERVICE}; #[test] fn uses_stable_keyring_identity() { assert_eq!(SERVICE, "business-assistant"); assert_eq!(ACCOUNT, "refresh-token"); } }
