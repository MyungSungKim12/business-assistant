# 2026-10-20 대기 예약 제안 (APT-19)

## 구현 범위

- Supabase SQL 072 adds ranked candidate slots with expiry, action status, and an append-only event record. A new proposal set supersedes earlier active candidates for that waitlist entry.
- The waitlist screen can collect up to ten candidate times, show their rank and expiry, accept one, or dismiss it. Acceptance reuses the atomic waitlist-to-appointment RPC, so staff/resource conflicts are checked again before booking. Other open candidates become superseded in the same transaction.
- Proposals remain internal. The UI explicitly tells staff to contact customers separately. No SMS, automatic fee, or cancellation charge is created.

## 검증

- `node scripts/db-tests/appointments.mjs --offers`: 통과. 제안 생성/멱등 재시도/목록/닫기/수락/수락 재시도/만료 처리와 예약 변환을 격리 DB에서 확인했다.
- `pnpm --filter @business-assistant/api test -- src/routes/appointments.test.ts`: 예약 라우트 11건 통과.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/appointments/WaitlistDialog.test.tsx`: 내부 제안 후보 등록 화면 테스트 통과.
- API 및 React 빌드 검증은 뒤의 통합 문서 검증에서 다시 수행한다.

## 제한

- SQL 072는 Supabase 적용 전이며 실계정·실앱 검증을 하지 않았다.
- 현재 화면은 직원이 시간 후보를 선택해 내부 제안을 만든다. 고객용 메시지 발송, 메시지 열람/응답 상태, 문자 공급자, 자동 위약금은 구현하지 않았다.
- 만료는 목록에서 만료로 표시하고 사용자가 처리할 때 이력에 확정 기록한다. 백그라운드 스케줄러는 추가하지 않았다.
