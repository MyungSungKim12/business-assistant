//! 클라이언트 로그 파일. UTF-8, 전화번호는 가려서 쓴다.
//!
//! - 위치: `%LOCALAPPDATA%\com.businessassistant.desktop\logs\business-assistant.log`
//! - 순환: 1MB를 넘으면 `.1.log`, `.2.log`로 넘긴다(최대 3개).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

const FILE: &str = "business-assistant";
const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: usize = 2;

static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 앱 시작 시 한 번 호출한다. 폴더를 못 정하면 임시 폴더로 대체하고, 그것도 안 되면 파일 로그 없이 계속한다.
pub fn init(app: &AppHandle) -> String {
    let primary = app.path().app_log_dir().map_err(|e| e.to_string());
    let candidates = [primary.clone().ok(), Some(std::env::temp_dir().join("business-assistant-logs"))];
    for path in candidates.into_iter().flatten() {
        if fs::create_dir_all(&path).is_ok() {
            if let Ok(mut guard) = DIR.lock() {
                *guard = Some(path.clone());
            }
            return path.display().to_string();
        }
    }
    format!("로그 폴더 없음({})", primary.err().unwrap_or_default())
}

fn dir() -> Option<PathBuf> {
    DIR.lock().ok().and_then(|guard| guard.clone())
}

/// 숫자가 9~13자리인 연속 구간(하이픈 포함)을 전화번호로 보고 가운데를 가린다.
pub fn mask_phones(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        let mut digits = 0;
        while j < chars.len() && (chars[j].is_ascii_digit() || (chars[j] == '-' && j + 1 < chars.len() && chars[j + 1].is_ascii_digit())) {
            if chars[j].is_ascii_digit() {
                digits += 1;
            }
            j += 1;
        }
        if (9..=13).contains(&digits) {
            let mut seen = 0;
            for c in &chars[start..j] {
                if c.is_ascii_digit() {
                    seen += 1;
                    out.push(if seen <= 3 || seen > digits - 4 { *c } else { '*' });
                } else {
                    out.push(*c);
                }
            }
        } else {
            out.extend(&chars[start..j]);
        }
        i = j;
    }
    out
}

fn rotate(folder: &PathBuf) {
    let path = |n: usize| if n == 0 { folder.join(format!("{FILE}.log")) } else { folder.join(format!("{FILE}.{n}.log")) };
    let _ = fs::remove_file(path(KEEP));
    for n in (0..KEEP).rev() {
        let _ = fs::rename(path(n), path(n + 1));
    }
}

pub fn write(level: &str, message: &str) {
    let line = format!("{} [{}] {}\n", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), level, mask_phones(message));
    eprint!("{line}");
    let Some(folder) = dir() else { return };
    let file = folder.join(format!("{FILE}.log"));
    if fs::metadata(&file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        rotate(&folder);
    }
    if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(file) {
        let _ = handle.write_all(line.as_bytes());
    }
}

#[macro_export]
macro_rules! ba_log {
    ($level:expr, $($arg:tt)*) => { $crate::logfile::write($level, &format!($($arg)*)) };
}

/// 프런트엔드가 시작 실패나 오류를 남길 때 쓴다.
#[tauri::command]
pub fn log_write(level: String, message: String) {
    let level = match level.as_str() { "ERROR" | "WARN" => level, _ => "INFO".to_string() };
    write(&level, &message.chars().take(2000).collect::<String>());
}

#[cfg(test)]
mod tests {
    use super::mask_phones;
    #[test]
    fn masks_long_digit_runs() {
        assert_eq!(mask_phones("call 01012345678 now"), "call 010****5678 now");
        assert_eq!(mask_phones("010-1234-5678"), "010-****-5678");
        assert_eq!(mask_phones("order 12345"), "order 12345");
    }
}
