use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use futures_util::future::{select, Either};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::oneshot;
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

/// 업로드 진행률 이벤트 이름. 프런트엔드가 `listen`으로 받는다.
pub const UPLOAD_PROGRESS_EVENT: &str = "upload:progress";
/// 사용자가 취소했을 때 돌려주는 오류 문구. 프런트엔드는 자신의 취소 요청과 함께 이 값으로 취소를 구분한다.
pub const UPLOAD_CANCELLED: &str = "업로드가 취소되었습니다.";
const UPLOAD_CHUNK_BYTES: usize = 64 * 1024;
const PROGRESS_STEP_BYTES: u64 = 128 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UploadProgress { id: String, sent: u64, total: u64 }

type CancelMap = Mutex<HashMap<String, oneshot::Sender<()>>>;

/// 진행 중인 업로드의 취소 신호 보관소(업로드 ID → 신호 송신부).
static UPLOADS: OnceLock<CancelMap> = OnceLock::new();
fn uploads() -> &'static CancelMap { UPLOADS.get_or_init(|| Mutex::new(HashMap::new())) }

/// 업로드가 끝나거나 실패하면(함수 종료) 보관소에서 자기 ID를 지운다.
struct UploadGuard(String);
impl Drop for UploadGuard {
    fn drop(&mut self) { if let Ok(mut map) = uploads().lock() { map.remove(&self.0); } }
}

fn register_upload(id: &str) -> Result<(UploadGuard, oneshot::Receiver<()>), String> {
    let mut map = uploads().lock().map_err(|_| "업로드 상태를 확인할 수 없습니다.".to_string())?;
    if map.contains_key(id) { return Err("이미 진행 중인 업로드 ID입니다.".into()); }
    let (sender, receiver) = oneshot::channel();
    map.insert(id.to_string(), sender);
    Ok((UploadGuard(id.to_string()), receiver))
}

/// 진행 중인 업로드를 취소한다. 취소 신호를 보냈으면 true, 이미 끝났거나 모르는 ID면 false.
fn cancel_registered(id: &str) -> bool {
    let sender = uploads().lock().ok().and_then(|mut map| map.remove(id));
    sender.is_some_and(|sender| sender.send(()).is_ok())
}

#[tauri::command]
pub fn upload_cancel(id: String) -> bool { cancel_registered(&id) }

/// 진행률 이벤트를 너무 자주 보내지 않도록 128KB(또는 전체의 1%)마다, 그리고 끝났을 때만 보낸다.
fn should_emit_progress(sent: u64, last_emitted: u64, total: u64) -> bool {
    sent >= total || sent.saturating_sub(last_emitted) >= PROGRESS_STEP_BYTES.max(total / 100)
}

struct ChunkReader { file: tokio::fs::File, sent: u64, last_emitted: u64, total: u64, progress: Option<(AppHandle, String)> }

impl ChunkReader {
    fn report(&mut self) {
        if let Some((app, id)) = &self.progress {
            if should_emit_progress(self.sent, self.last_emitted, self.total) {
                self.last_emitted = self.sent;
                let _ = app.emit(UPLOAD_PROGRESS_EVENT, UploadProgress { id: id.clone(), sent: self.sent, total: self.total });
            }
        }
    }
}

fn changed_size_error() -> std::io::Error { std::io::Error::new(std::io::ErrorKind::InvalidData, "선택 후 파일 크기가 변경되었습니다.") }

/// 파일을 64KB씩 읽어 내보내는 본문 스트림. 읽은 만큼 진행률을 알리고, 파일 크기가 선택 때와 달라지면 오류로 끝낸다.
fn chunk_stream(reader: ChunkReader) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    futures_util::stream::unfold(reader, |mut reader| async move {
        let mut buffer = vec![0u8; UPLOAD_CHUNK_BYTES];
        match reader.file.read(&mut buffer).await {
            Ok(0) if reader.sent == reader.total => None,
            Ok(0) => Some((Err(changed_size_error()), reader)),
            Ok(read) => {
                buffer.truncate(read);
                reader.sent += read as u64;
                if reader.sent > reader.total { return Some((Err(changed_size_error()), reader)); }
                reader.report();
                Some((Ok(buffer), reader))
            }
            Err(error) => Some((Err(error), reader)),
        }
    })
}

/// 서명 URL로 파일을 올린다. `id`가 있으면 진행률 이벤트(upload:progress)를 보내고 `upload_cancel(id)`로 취소할 수 있다.
/// `id`가 없으면(기존 사진 업로드) 같은 스트리밍 경로를 쓰되 이벤트·취소는 없다.
#[tauri::command]
pub async fn upload_binary(app: AppHandle, id: Option<String>, url: String, path: String, content_type: String, size: u64) -> Result<(), String> {
    let cfg = config::load()?;
    let target = http::signed_url(&url, &cfg.storage_host)?;
    let file_path = PathBuf::from(path);
    // 사진(image/*)은 10MB·내용(매직 바이트)까지 검사하고, 그 외 파일 자료는 50MB·확장자 형식을 확인한다.
    let is_image = content_type.starts_with("image/");
    let detected = if is_image { validate_image(&file_path, size)?.1 } else { validate_file(&file_path, size)?.1 };
    if detected != content_type { return Err("파일 형식과 전송 형식이 일치하지 않습니다.".into()); }
    let registration = match &id { Some(id) => Some(register_upload(id)?), None => None };
    let mut file = tokio::fs::File::open(&file_path).await.map_err(|e| e.to_string())?;
    let actual = file.metadata().await.map_err(|e| e.to_string())?.len();
    if actual != size { return Err("선택 후 파일 크기가 변경되었습니다.".into()); }
    if is_image {
        let mut head = [0u8; 12];
        let read = file.read(&mut head).await.map_err(|e| e.to_string())?;
        validate_magic(&head[..read], &detected)?;
        file.seek(std::io::SeekFrom::Start(0)).await.map_err(|e| e.to_string())?;
    }
    let progress = id.clone().map(|id| (app.clone(), id));
    let reader = ChunkReader { file, sent: 0, last_emitted: 0, total: size, progress };
    let request = reqwest::Client::new().put(target).header("Content-Type", detected).header("Content-Length", size)
        .body(reqwest::Body::wrap_stream(chunk_stream(reader))).send();
    let outcome = match registration {
        Some((_guard, cancelled)) => match select(Box::pin(request), cancelled).await {
            Either::Left((result, _)) => result,
            Either::Right(_) => return Err(UPLOAD_CANCELLED.into()),
        },
        None => request.await,
    };
    let response = outcome.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("업로드에 실패했습니다. ({})", response.status())); }
    if let Some(id) = id { let _ = app.emit(UPLOAD_PROGRESS_EVENT, UploadProgress { id, sent: size, total: size }); }
    Ok(())
}

#[tauri::command]
pub async fn download_binary(url: String) -> Result<Vec<u8>, String> {
    let cfg = config::load()?;
    let target = http::signed_url(&url, &cfg.storage_host)?;
    let response = reqwest::Client::new().get(target).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("파일 다운로드에 실패했습니다. ({})", response.status())); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    // 사진 외에 PDF 미리보기·파일 내려받기에도 쓰므로 파일 자료 한도(50MB)까지 허용한다.
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err("다운로드 파일이 50MB를 초과합니다.".into()); }
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

/// pdf는 `%PDF-`로 시작해야 하고, xlsx는 zip 컨테이너(PK)여야 하며 csv는 아니어야 한다. 확장자만 바꾼 다른 파일을 걸러낸다.
fn validate_data_content(name: &str, bytes: &[u8]) -> Result<(), String> {
    // PDF 는 `%PDF-` 머리말이 있어야 한다.
    if name.to_ascii_lowercase().ends_with(".pdf") {
        return if bytes.starts_with(b"%PDF-") { Ok(()) } else { Err("올바른 PDF 파일이 아닙니다.".into()) };
    }
    let is_xlsx = name.to_ascii_lowercase().ends_with(".xlsx");
    if is_xlsx && !bytes.starts_with(b"PK") { return Err("올바른 엑셀(.xlsx) 파일이 아닙니다.".into()); }
    if !is_xlsx && bytes.starts_with(b"PK") { return Err("CSV가 아닌 압축 형식 파일입니다. 확장자를 확인하세요.".into()); }
    Ok(())
}

/// 저장 제안 이름: 경로 구분자 없이 csv/xlsx/pdf 확장자만 허용한다. 소문자 확장자를 돌려준다.
fn validate_save_name(name: &str) -> Result<String, String> {
    if !is_safe_file_name(name) { return Err("저장할 파일 이름이 올바르지 않습니다.".into()); }
    let ext = Path::new(name).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "csv" | "xlsx" | "pdf") { return Err("엑셀(.xlsx), CSV 또는 PDF로만 저장할 수 있습니다.".into()); }
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

/// 내보내기 저장(csv/xlsx/pdf): 저장 대화상자에서 경로를 고르고 쓴다. 덮어쓰기 확인은 OS 대화상자가 한다. 취소하면 None, 저장하면 경로.
#[tauri::command]
pub fn save_data_file(suggested_name: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
    let ext = validate_save_name(&suggested_name)?;
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES { return Err("저장할 내용의 크기가 올바르지 않습니다.".into()); }
    validate_data_content(&suggested_name, &bytes)?;
    let label = match ext.as_str() { "xlsx" => "엑셀 파일", "pdf" => "PDF 파일", _ => "CSV 파일" };
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
    use super::{cancel_registered, register_upload, should_emit_progress, validate_data_content, validate_data_file, validate_file, validate_image, validate_magic, validate_save_name, MAX_DATA_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES}; use std::path::Path;
    #[test] fn data_file_accepts_csv_and_xlsx_within_limit() { assert_eq!(validate_data_file(Path::new("고객.XLSX"), 100).unwrap(), "고객.XLSX"); assert!(validate_data_file(Path::new("a.csv"), MAX_DATA_BYTES).is_ok()); }
    #[test] fn data_file_rejects_other_extension_empty_or_oversized() { assert!(validate_data_file(Path::new("a.xls"), 10).is_err()); assert!(validate_data_file(Path::new("a.exe"), 10).is_err()); assert!(validate_data_file(Path::new("a"), 10).is_err()); assert!(validate_data_file(Path::new("a.csv"), 0).is_err()); assert!(validate_data_file(Path::new("a.csv"), MAX_DATA_BYTES + 1).is_err()); }
    #[test] fn data_content_must_match_extension() { assert!(validate_data_content("a.xlsx", b"PK\x03\x04").is_ok()); assert!(validate_data_content("a.xlsx", b"name,phone").is_err()); assert!(validate_data_content("a.csv", b"name,phone").is_ok()); assert!(validate_data_content("a.csv", b"PK\x03\x04").is_err()); }
    #[test] fn save_name_allows_only_safe_csv_or_xlsx() { assert_eq!(validate_save_name("고객_20260101.xlsx").unwrap(), "xlsx"); assert_eq!(validate_save_name("a.CSV").unwrap(), "csv"); assert!(validate_save_name("../a.csv").is_err()); assert!(validate_save_name("a\\b.csv").is_err()); assert!(validate_save_name("a.exe").is_err()); assert!(validate_save_name("").is_err()); assert!(validate_save_name("a:b.csv").is_err()); }
    #[test] fn accepts_supported_images() { assert_eq!(validate_image(Path::new("고객사진.JPEG"), 20).unwrap().1, "image/jpeg"); assert_eq!(validate_image(Path::new("a.webp"), 20).unwrap().1, "image/webp"); }
    #[test] fn rejects_bad_extension_or_size() { assert!(validate_image(Path::new("a.gif"), 20).is_err()); assert!(validate_image(Path::new("a.png"), MAX_IMAGE_BYTES + 1).is_err()); }
    #[test] fn rejects_disguised_image_content() { assert!(validate_magic(b"not an image", "image/jpeg").is_err()); assert!(validate_magic(&[0xff, 0xd8, 0xff, 0x00], "image/jpeg").is_ok()); }
    #[test] fn accepts_documents_up_to_the_file_limit() { assert_eq!(validate_file(Path::new("동의서.PDF"), 20).unwrap().1, "application/pdf"); assert_eq!(validate_file(Path::new("a.xlsx"), MAX_FILE_BYTES).unwrap().1, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); }
    #[test] fn rejects_unknown_empty_or_oversized_files() { assert!(validate_file(Path::new("a.exe"), 20).is_err()); assert!(validate_file(Path::new("a.pdf"), 0).is_err()); assert!(validate_file(Path::new("a.pdf"), MAX_FILE_BYTES + 1).is_err()); }
    #[test] fn save_name_and_content_accept_pdf_with_header_only() {
        assert_eq!(validate_save_name("동의서_홍길동.PDF").unwrap(), "pdf");
        assert!(validate_data_content("a.pdf", b"%PDF-1.7").is_ok());
        assert!(validate_data_content("a.pdf", b"PK").is_err());
        assert!(validate_data_content("a.pdf", b"name,phone").is_err());
        assert!(validate_save_name("a.pdf.exe").is_err());
        assert!(validate_save_name("../a.pdf").is_err());
    }
    #[test] fn progress_is_throttled_but_always_reports_completion() {
        let total = 10 * 1024 * 1024;
        assert!(!should_emit_progress(64 * 1024, 0, total));
        assert!(should_emit_progress(128 * 1024, 0, total));
        assert!(!should_emit_progress(200 * 1024, 128 * 1024, total));
        assert!(should_emit_progress(total, total - 10, total));
        assert!(should_emit_progress(1, 0, 1));
    }
    #[test] fn cancel_signals_only_registered_uploads_once() {
        let (guard, mut receiver) = register_upload("test-upload-1").unwrap();
        assert!(register_upload("test-upload-1").is_err());
        assert!(cancel_registered("test-upload-1"));
        assert!(receiver.try_recv().is_ok());
        assert!(!cancel_registered("test-upload-1"));
        assert!(!cancel_registered("unknown-upload"));
        drop(guard);
        assert!(register_upload("test-upload-1").is_ok());
    }
}
