# Native HTTP 요청 시간 제한·미확인 결과 보존

날짜: 2026-10-19. 기능: OPS-05(신규), OPS-03/UX-08 연계, 감사 F15. 상태 in-progress. 신규 ID 사유: 기존 진단·업데이트·입력 보호와 별도로 Native 통신 deadline 및 결과 미확인을 추적한다. 선행: React/Tauri Native HTTP와 기존 멱등·복구 흐름.

사용자가 SQL 063까지 실행 완료했다고 보고했다. 원격 독립 확인은 하지 않았다. **이번 변경은 추가 SQL이 없다.**

## 원인과 구현

기존 Rust API 요청은 reqwest Client 기본 설정을 사용했다. 연결·본문을 포함한 전체 요청의 제한이 없어 응답을 받지 못하면 저장 중 상태가 계속 남을 수 있었다.

- 일반/관리자 API에 연결 10초, 응답 본문 수신까지 전체 45초 제한을 적용한다. 연결 제한이 전체 제한에 추가되는 방식이 아니라 전체 요청 안에 포함된다.
- 사진·파일 전송은 별도 전체 300초/연결 10초를 적용한다. 기존 업로드 취소 신호·진행률 경로는 유지한다. API 제한을 50MB 파일 전송에 그대로 사용하지 않는다.
- Native API 오류를 `code/message/retryable` 구조로 전달한다. timeout은 NATIVE_TIMEOUT, 기타 네트워크 실패는 NATIVE_TRANSPORT, 설정/경로 오류는 NATIVE_CONFIG다. reqwest 원문 URL·헤더·본문은 전달하지 않는다.
- Tauri 플랫폼은 timeout을 status 0/retryable ApiError로 전달한다. 이전 Native String 오류도 호환한다. 파일 명령의 String 오류 계약은 유지하며 네트워크 오류 문구만 비밀정보 없는 안내로 바꿨다.
- 요청을 자동 재전송하지 않는다. 기존 수납 복구는 status 0을 확정 거절로 보지 않아 pending/operation_id를 보존한다. 명시적 재시도에서 같은 요청을 보낸다.
- 리다이렉트를 자동으로 따르지 않는다. 동일 POST가 다른 경로로 자동 전달되지 않고 원래 응답 코드로 처리된다. 서명 URL은 최종 Storage 주소여야 한다.

계약은 프로젝트가 사용하는 reqwest 0.12.28의 설치된 소스 `async_impl/client.rs`의 timeout/connect_timeout 설명도 확인했다. [reqwest ClientBuilder 문서](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html)와 달리 latest는 다른 버전일 수 있으므로 로컬 0.12.28 구현을 우선했다.

## 검증

| 명령 | 결과 |
| --- | --- |
| `cargo test --manifest-path apps/desktop-react/src-tauri/Cargo.toml --lib network::tests -- --nocapture` | 2개 통과. 로컬 지연 헤더·지연 본문 timeout, 오류 URL 비노출, POST redirect 차단 |
| 동일 Cargo 명령의 `http::tests` 필터 | 4개 통과. API 경로/쿼리와 Storage host 규칙 |
| 동일 Cargo 명령의 `files::tests::cancel_signals_only_registered_uploads_once` 필터 | 1개 통과. 기존 업로드 취소 신호 |
| React `vitest run src/features/sales/NativeTimeoutRecovery.test.tsx src/platform/tauri.test.ts src/features/sales/recovery.test.tsx src/api/client.test.ts src/api/clientSecurity.test.ts src/features/sales/PaymentDialog.test.tsx` | 48개 통과 |
| React `tsc -p tsconfig.app.json --noEmit` | 통과 |

구조화된 timeout이 `[object Object]`로 사라지는 JS 선행 실패를 재현하고 수정했다. Tauri invoke 모의→ApiClient→수납 recovery 연결에서 미확인 보존·자동 재전송 없음·같은 operation_id 재시도·성공 후 복구 정리를 확인했다. Rust는 실제 요청 helper를 짧은 100ms deadline과 로컬 임시 HTTP 소켓으로 검증했다. 실제 운영 API나 앱 창은 열지 않았다.

독립 소스 리뷰의 중요 지적은 없었다. 전체 테스트·실환경·설치본·커밋/푸시는 수행하지 않았다. 네트워크 helper를 포함한 Rust 테스트 바이너리 컴파일·실행은 성공했으나 제품 전체를 verified로 표기하지 않는다.

## 반영과 제한

Rust 소스가 바뀌었으므로 기존 실행 중인 Native 프로세스나 이전 설치본에는 바로 적용되지 않는다. 개발 모드라면 최신 소스로 Native 앱을 다시 시작/빌드하고, 설치본은 후속 배포가 필요하다. SQL 추가 실행은 없다.

- 제한은 개별 HTTP 요청 기준이다. 401 후 토큰 갱신 및 재요청을 포함한 전체 사용자 동작은 여러 요청의 시간을 사용할 수 있다.
- IPC 호출 자체, OS 파일 선택창·로컬 파일 접근·초기 설정 로드는 이 HTTP deadline의 대상이 아니다. 연결 제한의 실제 DNS/프록시/인증서 환경은 별도 인수가 필요하다.
- 일반 API의 새로운 AbortSignal IPC·사용자 취소 버튼, 브라우저 미리보기 fetch deadline은 이번 범위에서 추가하지 않았다. 기존 파일 업로드 취소만 유지했다.
- 모든 비멱등 CRUD가 영속 recovery로 바뀐 것은 아니다. 타임아웃은 서버 트랜잭션 취소를 보증하지 않는다. 고객 등록 등 멱등 키가 없는 기능은 저장 결과를 확인한 뒤 재시도해야 한다.
- 45초/300초 정책은 실매장 네트워크 성능을 측정해 정한 수치가 아니라 현재 API 배치 최대 30초와 파일 최대 크기를 고려한 기본 정책이다. 성능 인수 후 조정 가능하다.

다음 우선순위: F16 예약 가능 시간 조회의 직원별 다중 DB 호출 축소.
