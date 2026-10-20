use std::time::Duration;
use reqwest::Client;
use serde::Serialize;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const API_TIMEOUT: Duration = Duration::from_secs(45);
pub const FILE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
pub struct NativeHttpError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl NativeHttpError {
    pub fn invalid(message: &'static str) -> Self {
        Self { code: "NATIVE_CONFIG", message, retryable: false }
    }
}

pub fn transport_error(error: reqwest::Error) -> NativeHttpError {
    // reqwest 원문에는 토큰을 포함한 URL이 들어갈 수 있어 IPC/로그로 전달하지 않는다.
    if error.is_timeout() {
        NativeHttpError { code: "NATIVE_TIMEOUT", message: "서버 응답 시간이 초과되었습니다. 저장 요청은 처리됐을 수 있으므로 같은 요청으로 결과를 확인하세요.", retryable: true }
    } else {
        NativeHttpError { code: "NATIVE_TRANSPORT", message: "서버와 통신하지 못했습니다. 연결을 확인하세요. 저장 요청의 결과는 아직 확인되지 않았습니다.", retryable: true }
    }
}

pub fn client(timeout: Duration) -> Result<Client, NativeHttpError> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| NativeHttpError::invalid("네트워크 통신을 초기화하지 못했습니다."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread, time::Instant};

    // 외부 서버·실제 앱 없이 헤더와 본문에서 각각 멈추는 서버를 만든다.
    fn stalled_server(send_headers: bool) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let _ = stream.read(&mut [0u8; 4096]);
            if send_headers { let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx"); }
            thread::sleep(Duration::from_millis(350));
        });
        (format!("http://{address}/test?token=not-for-errors"), handle)
    }

    #[test]
    fn bounds_delayed_headers_and_body() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for headers in [false, true] {
            let (url, server) = stalled_server(headers);
            let started = Instant::now();
            let error = runtime.block_on(async {
                let response = client(Duration::from_millis(100)).unwrap().get(url).send().await;
                match response { Err(error) => error, Ok(response) => response.text().await.unwrap_err() }
            });
            assert!(started.elapsed() < Duration::from_secs(2));
            let error = transport_error(error);
            assert_eq!(error.code, "NATIVE_TIMEOUT");
            assert!(error.retryable);
            assert!(!serde_json::to_string(&error).unwrap().contains("not-for-errors"));
            server.join().unwrap();
        }
    }

    #[test]
    fn refuses_redirect_replay() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0u8; 4096]);
            stream.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let status = runtime.block_on(async { client(API_TIMEOUT).unwrap().post(format!("http://{address}/save")).body("operation_id=same").send().await.unwrap().status() });
        assert_eq!(status.as_u16(), 307);
        server.join().unwrap();
    }
}
