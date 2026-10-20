# F15 Native HTTP 시간 제한

기능 OPS-05(신규: 감사 F15 독립 추적), OPS-03 / UX-08 연계, 감사 F15. 상태 in-progress. 사용자 SQL 063 적용 완료 보고 기록. 이번 SQL 없음.

1. Rust http_request의 기본 Client에 연결 10초·본문 수신 포함 전체 45초 제한을 추가한다. 일반/관리자 API에 같은 정책 적용. timeout/연결 오류/유효하지 않은 설정을 구조화해 원문 URL·헤더·본문을 오류로 노출하지 않는다. 자동 재전송 금지.
2. Tauri 플랫폼에서 구조화된 timeout을 status 0/retryable ApiError로 전달한다. 응답 없는 쓰기는 확정 거절이 아니다. 기존 String 오류도 호환한다.
3. 파일 전송은 별도 5분 전체 제한·10초 연결 제한을 적용해 큰 파일에 API 45초 제한을 강요하지 않는다. 기존 upload_cancel은 유지한다.
4. 지연 헤더/지연 본문을 로컬 Rust 테스트에서 짧은 deadline으로 검사하고 JS 오류 전달·수납 recovery 동일 operation_id 재시도를 집중 검증한다. Rust 실행이 환경에 막히면 정확한 제한을 기록한다.
5. 타입 검사·독립 리뷰·제품 문서 최신화. 실제 앱·운영 API·전체 테스트·커밋/푸시 없음.

범위 선택: 일반 API의 사용자 취소 신호/버튼·AbortSignal IPC는 별도 설계로 남긴다. 이번에는 끝나지 않는 Native 요청을 제한하고 기존 업로드 취소만 유지한다. 브라우저 미리보기의 fetch 정책 변경과 모든 비멱등 CRUD의 영속 복구 전환도 이번 범위가 아니다.

구현·집중 검증: Rust 7개·React 48개·타입 검사 통과. 독립 리뷰 중요 지적 없음. 네트워크 정책과 Native 재빌드 필요·사용자 API 취소/브라우저 미포함 등의 제한은 [제품 기록](../../product/audits/2026-10-19-native-http-deadline.md)을 따른다.
