use std::path::{Path, PathBuf};
use serde::Serialize;
use crate::{config, http};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedImage { name: String, content_type: String, size: u64, path: String }

fn validate_image(path: &Path, size: u64) -> Result<(&str, String), String> {
    if size == 0 || size > MAX_IMAGE_BYTES { return Err("사진은 10MB 이하여야 합니다.".into()); }
    let name = path.file_name().and_then(|v| v.to_str()).ok_or_else(|| "안전한 파일 이름이 필요합니다.".to_string())?;
    if name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\')) { return Err("안전한 파일 이름이 필요합니다.".into()); }
    let content_type = match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg", "png" => "image/png", "webp" => "image/webp", _ => return Err("JPEG, PNG, WebP 사진만 선택할 수 있습니다.".into()),
    };
    Ok((name, content_type.into()))
}

#[tauri::command]
pub fn pick_images() -> Result<Option<Vec<PickedImage>>, String> {
    let selected = rfd::FileDialog::new().add_filter("사진", &["jpg", "jpeg", "png", "webp"]).pick_files();
    selected.map(|paths| paths.into_iter().map(|path| {
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let (name, content_type) = validate_image(&path, size)?;
        Ok(PickedImage { name: name.into(), content_type, size, path: path.to_string_lossy().into_owned() })
    }).collect()).transpose()
}

#[tauri::command]
pub async fn upload_binary(url: String, path: String, content_type: String, size: u64) -> Result<(), String> {
    let cfg = config::load()?;
    let target = http::signed_url(&url, &cfg.storage_host)?;
    let file = PathBuf::from(path);
    let (_, detected) = validate_image(&file, size)?;
    if detected != content_type { return Err("파일 형식과 전송 형식이 일치하지 않습니다.".into()); }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size { return Err("선택 후 파일 크기가 변경되었습니다.".into()); }
    let response = reqwest::Client::new().put(target).header("Content-Type", detected).body(bytes).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("사진 업로드에 실패했습니다. ({})", response.status())); }
    Ok(())
}

#[tauri::command]
pub async fn download_binary(url: String) -> Result<Vec<u8>, String> {
    let cfg = config::load()?;
    let target = http::signed_url(&url, &cfg.storage_host)?;
    let response = reqwest::Client::new().get(target).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("사진 다운로드에 실패했습니다. ({})", response.status())); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES { return Err("다운로드 사진이 10MB를 초과합니다.".into()); }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::{validate_image, MAX_IMAGE_BYTES}; use std::path::Path;
    #[test] fn accepts_supported_images() { assert_eq!(validate_image(Path::new("고객사진.JPEG"), 20).unwrap().1, "image/jpeg"); assert_eq!(validate_image(Path::new("a.webp"), 20).unwrap().1, "image/webp"); }
    #[test] fn rejects_bad_extension_or_size() { assert!(validate_image(Path::new("a.gif"), 20).is_err()); assert!(validate_image(Path::new("a.png"), MAX_IMAGE_BYTES + 1).is_err()); }
}
