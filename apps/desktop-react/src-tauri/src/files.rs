use std::path::{Path, PathBuf};
use serde::Serialize;
use crate::{config, http};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

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

/// 일반 파일 자료: 이름·크기를 확인하고 확장자로 전송 형식을 정한다(내용 검사는 서버 정책에 따른다).
fn validate_file(path: &Path, size: u64) -> Result<(String, String), String> {
    if size == 0 || size > MAX_FILE_BYTES { return Err("파일은 50MB 이하여야 합니다.".into()); }
    let name = path.file_name().and_then(|v| v.to_str()).ok_or_else(|| "안전한 파일 이름이 필요합니다.".to_string())?;
    if name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\')) { return Err("안전한 파일 이름이 필요합니다.".into()); }
    let content_type = match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg", "png" => "image/png", "webp" => "image/webp",
        "txt" => "text/plain", "csv" => "text/csv", "zip" => "application/zip",
        "doc" => "application/msword", "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel", "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint", "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "hwp" => "application/x-hwp", "hwpx" => "application/hwp+zip",
        _ => return Err("지원하지 않는 파일 형식입니다. PDF, 문서, 스프레드시트, 이미지, 압축 파일을 올릴 수 있습니다.".into()),
    };
    Ok((name.to_string(), content_type.into()))
}

fn validate_magic(bytes: &[u8], content_type: &str) -> Result<(), String> {
    let valid = match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if valid { Ok(()) } else { Err("파일 내용이 선언된 이미지 형식과 일치하지 않습니다.".into()) }
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
pub fn pick_files() -> Result<Option<Vec<PickedImage>>, String> {
    let selected = rfd::FileDialog::new().pick_files();
    selected.map(|paths| paths.into_iter().map(|path| {
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let (name, content_type) = validate_file(&path, size)?;
        Ok(PickedImage { name, content_type, size, path: path.to_string_lossy().into_owned() })
    }).collect()).transpose()
}

#[tauri::command]
pub async fn upload_binary(url: String, path: String, content_type: String, size: u64) -> Result<(), String> {
    let cfg = config::load()?;
    let target = http::signed_url(&url, &cfg.storage_host)?;
    let file = PathBuf::from(path);
    // 사진(image/*)은 10MB·내용(매직 바이트)까지 검사하고, 그 외 파일 자료는 50MB·확장자 형식을 확인한다.
    let is_image = content_type.starts_with("image/");
    let detected = if is_image { validate_image(&file, size)?.1 } else { validate_file(&file, size)?.1 };
    if detected != content_type { return Err("파일 형식과 전송 형식이 일치하지 않습니다.".into()); }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.len() as u64 != size { return Err("선택 후 파일 크기가 변경되었습니다.".into()); }
    if is_image { validate_magic(&bytes, &detected)?; }
    let response = reqwest::Client::new().put(target).header("Content-Type", detected).body(bytes).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("업로드에 실패했습니다. ({})", response.status())); }
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

/// 엑셀·CSV 가져오기 파일 최대 크기(5MB)와 내보내기 저장 최대 크기(20MB).
const MAX_DATA_BYTES: u64 = 5 * 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedData { name: String, size: u64, bytes: Vec<u8> }

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 200
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// 가져오기 파일: 확장자는 csv/xlsx만, 크기는 1바이트 이상 5MB 이하. 안전한 파일 이름을 돌려준다.
fn validate_data_file(path: &Path, size: u64) -> Result<String, String> {
    if size == 0 { return Err("빈 파일입니다.".into()); }
    if size > MAX_DATA_BYTES { return Err("파일은 5MB 이하여야 합니다.".into()); }
    let name = path.file_name().and_then(|v| v.to_str()).ok_or_else(|| "안전한 파일 이름이 필요합니다.".to_string())?;
    if name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\')) { return Err("안전한 파일 이름이 필요합니다.".into()); }
    match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "csv" | "xlsx" => Ok(name.to_string()),
        _ => Err("엑셀(.xlsx) 또는 CSV 파일만 선택할 수 있습니다.".into()),
    }
}

/// xlsx는 zip 컨테이너(PK)여야 하고 csv는 아니어야 한다. 확장자만 바꾼 다른 파일을 걸러낸다.
fn validate_data_content(name: &str, bytes: &[u8]) -> Result<(), String> {
    let is_xlsx = name.to_ascii_lowercase().ends_with(".xlsx");
    if is_xlsx && !bytes.starts_with(b"PK") { return Err("올바른 엑셀(.xlsx) 파일이 아닙니다.".into()); }
    if !is_xlsx && bytes.starts_with(b"PK") { return Err("CSV가 아닌 압축 형식 파일입니다. 확장자를 확인하세요.".into()); }
    Ok(())
}

/// 저장 제안 이름: 경로 구분자 없이 csv/xlsx 확장자만 허용한다. 소문자 확장자를 돌려준다.
fn validate_save_name(name: &str) -> Result<String, String> {
    if !is_safe_file_name(name) { return Err("저장할 파일 이름이 올바르지 않습니다.".into()); }
    let ext = Path::new(name).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "csv" && ext != "xlsx" { return Err("엑셀(.xlsx) 또는 CSV로만 저장할 수 있습니다.".into()); }
    Ok(ext)
}

/// 가져오기용 엑셀/CSV 파일 선택. 취소하면 None. 파일 내용은 로그에 남기지 않는다.
#[tauri::command]
pub fn pick_data_file() -> Result<Option<PickedData>, String> {
    let Some(path) = rfd::FileDialog::new().add_filter("엑셀·CSV", &["xlsx", "csv"]).pick_file() else { return Ok(None) };
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err("파일을 선택하세요.".into()); }
    let name = validate_data_file(&path, meta.len())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DATA_BYTES { return Err("파일은 5MB 이하여야 합니다.".into()); }
    validate_data_content(&name, &bytes)?;
    Ok(Some(PickedData { name, size: bytes.len() as u64, bytes }))
}

/// 내보내기 저장: 저장 대화상자에서 경로를 고르고 쓴다. 덮어쓰기 확인은 OS 대화상자가 한다. 취소하면 None, 저장하면 경로.
#[tauri::command]
pub fn save_data_file(suggested_name: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
    let ext = validate_save_name(&suggested_name)?;
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES { return Err("저장할 내용의 크기가 올바르지 않습니다.".into()); }
    validate_data_content(&suggested_name, &bytes)?;
    let label = if ext == "xlsx" { "엑셀 파일" } else { "CSV 파일" };
    let Some(mut path) = rfd::FileDialog::new().set_file_name(&suggested_name).add_filter(label, &[ext.as_str()]).save_file() else { return Ok(None) };
    match path.extension().and_then(|v| v.to_str()).map(|v| v.to_ascii_lowercase()) {
        Some(chosen) if chosen == ext => {}
        None => { path.set_extension(&ext); }
        Some(_) => return Err(format!("확장자는 .{ext} 이어야 합니다.")),
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("파일을 저장하지 못했습니다. ({e})"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::{validate_data_content, validate_data_file, validate_file, validate_image, validate_magic, validate_save_name, MAX_DATA_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES}; use std::path::Path;
    #[test] fn data_file_accepts_csv_and_xlsx_within_limit() { assert_eq!(validate_data_file(Path::new("고객.XLSX"), 100).unwrap(), "고객.XLSX"); assert!(validate_data_file(Path::new("a.csv"), MAX_DATA_BYTES).is_ok()); }
    #[test] fn data_file_rejects_other_extension_empty_or_oversized() { assert!(validate_data_file(Path::new("a.xls"), 10).is_err()); assert!(validate_data_file(Path::new("a.exe"), 10).is_err()); assert!(validate_data_file(Path::new("a"), 10).is_err()); assert!(validate_data_file(Path::new("a.csv"), 0).is_err()); assert!(validate_data_file(Path::new("a.csv"), MAX_DATA_BYTES + 1).is_err()); }
    #[test] fn data_content_must_match_extension() { assert!(validate_data_content("a.xlsx", b"PK\x03\x04").is_ok()); assert!(validate_data_content("a.xlsx", b"name,phone").is_err()); assert!(validate_data_content("a.csv", b"name,phone").is_ok()); assert!(validate_data_content("a.csv", b"PK\x03\x04").is_err()); }
    #[test] fn save_name_allows_only_safe_csv_or_xlsx() { assert_eq!(validate_save_name("고객_20260101.xlsx").unwrap(), "xlsx"); assert_eq!(validate_save_name("a.CSV").unwrap(), "csv"); assert!(validate_save_name("../a.csv").is_err()); assert!(validate_save_name("a\\b.csv").is_err()); assert!(validate_save_name("a.exe").is_err()); assert!(validate_save_name("").is_err()); assert!(validate_save_name("a:b.csv").is_err()); }
    #[test] fn accepts_supported_images() { assert_eq!(validate_image(Path::new("고객사진.JPEG"), 20).unwrap().1, "image/jpeg"); assert_eq!(validate_image(Path::new("a.webp"), 20).unwrap().1, "image/webp"); }
    #[test] fn rejects_bad_extension_or_size() { assert!(validate_image(Path::new("a.gif"), 20).is_err()); assert!(validate_image(Path::new("a.png"), MAX_IMAGE_BYTES + 1).is_err()); }
    #[test] fn rejects_disguised_image_content() { assert!(validate_magic(b"not an image", "image/jpeg").is_err()); assert!(validate_magic(&[0xff, 0xd8, 0xff, 0x00], "image/jpeg").is_ok()); }
    #[test] fn accepts_documents_up_to_the_file_limit() { assert_eq!(validate_file(Path::new("동의서.PDF"), 20).unwrap().1, "application/pdf"); assert_eq!(validate_file(Path::new("a.xlsx"), MAX_FILE_BYTES).unwrap().1, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); }
    #[test] fn rejects_unknown_empty_or_oversized_files() { assert!(validate_file(Path::new("a.exe"), 20).is_err()); assert!(validate_file(Path::new("a.pdf"), 0).is_err()); assert!(validate_file(Path::new("a.pdf"), MAX_FILE_BYTES + 1).is_err()); }
}
