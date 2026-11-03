# 2026-10-30 우선순위 R1030-02~08 보완

후속 적용 상태: 사용자 명시 승인으로 **SQL 100 원격 적용 완료**, 프로젝트 재개·스키마/권한·사진 건수 유지 확인. [원격 적용 기록](2026-10-30-sql100-remote-application.md). 아래 미적용 문구는 코드 구현 직후의 이력이며, 현재 추가 수동 SQL 실행은 필요 없다. 앱/기기 인수는 계속 별도다.

기준: 현재 로컬 소스. [독립 점검](2026-10-30-project-source-review.md)의 남은 항목을 사용자 요청대로 순차 구현했다. 이전 미커밋 변경은 보존했으며 전체 테스트·앱 실사용·원격 DB 변경·커밋/푸시는 하지 않았다.

## 기능별 결과

| ID / 연결 기능 | 검증된 코드 범위 | 적용·실환경 상태 |
| --- | --- | --- |
| R1030-02 / CRM 목록·범용 operations | 기존 배열 API의 500/5000행 상한을 count-exact 완전 조회로 교체. 이름/시각 동률에 ID 정렬, 작은 DB 페이지도 실제 반환 수로 진행, 중복·조직 불일치·누락 count·중간 실패는 부분 성공 대신 오류 | 로컬 verified. 기존 공통 pager의 최대 20,000행·100회·30초 보호 한도는 유지. 초과 시 명시적 실패. 각 화면의 서버 검색/집계 전환은 후속 최적화 |
| R1030-03 / FILE-11 | 폴더명·정규화 태그·저장 한도 초안을 DraftBoundary에 등록. 업로드/다운로드·폴더/분류 변경·파일 버전 전송도 busy 보호. 실패와 저장 중 추가 입력 보존. 버전 작업 중 모달 닫기 차단 | 집중 React verified. Windows 종료/강제 종료 인수는 별도 |
| R1030-04 / SEC-07·INT-007 | 기존 번호 가림 옵션을 독립/앱 내 전화 카드에 적용. 원문은 매칭·메모 API에만 유지하고 독립 창에는 표시용 번호를 전달. 열린 카드도 설정 변경을 반영 | 로컬 verified. 이름·사진·메모의 노출 정책은 기존 동작 유지; 별도 노출 수준 설정은 추가 범위 |
| R1030-05 / INT-007 | 고객 상세는 메인 창이 이동을 수락한 뒤, 메모는 실제 다이얼로그가 열린 뒤 main 전용 ACK로 닫음. 이동 취소/실패·다른 메모 작성 중에는 기존 알림 유지. 만료/세션 변경 이벤트 거절, 중복 고객 액션 억제 | React/Native 집중 verified. 최소화·여러 모니터·OS 실제 조작은 별도 |
| R1030-06 / INT-005 | active 및 기존 status=vip 모두 번호부·정확 일치·응대 프로필/메모 대상으로 호환. 비활성/차단/보관·다른 조직은 제외. 고객 상태 데이터는 변경하지 않음 | API verified. 추가 SQL 없음 |
| R1030-07 / CRM-011·MED-001/002 | pending→Storage 실제 크기·MIME 확인→ready. 완료 응답 유실 시 멱등 재확인, PUT 응답만 유실된 경우도 복구. 불확실한 전송은 되돌릴 수 없는 삭제 대신 pending 유지. 조회 시 완료 객체 복구 및 130분 경과 미완료 기록 failed 격리. 기존 정상 사진 유지·기존 고아 메타데이터 격리 | API/React/격리 PostgreSQL verified. **SQL 100 원격 미적용**, 제품 기능 상태는 in-progress 유지 |
| R1030-08 / INT-006 | 동기화 동의·활성 매장에 한해 네트워크 연결 시 약 15분 주기 자동 전체 갱신. 앱 재진입 시 5분 이상 오래되었으면 별도 갱신 예약. 암호화한 마지막 동기화 시각/오래됨 표시. 전체 페이지 완료 후 원자 교체. generation+동의 검사로 최초 동기화 중 철회/매장 변경도 무효화, 주기 작업 취소. 갱신/토큰 갱신 직렬화 | Kotlin 정책 9 tests·APK 0.3.0 빌드 verified. 실제 Android 백그라운드/절전·통화는 미검증. 서버 버전 기반 증분 갱신은 후속 최적화 |

## 적용 순서

1. 099까지 적용한 Supabase SQL Editor에서 [100_customer_photo_upload_completion.sql](../../../migrations/100_customer_photo_upload_completion.sql) 전체 실행. 이번 작업에서는 원격 실행하지 않았다. 기존 정상 사진/Storage 객체는 삭제하지 않는다. 기존 객체가 없는 메타데이터는 pending으로 격리하며 새 객체 존재를 확인하기 전 표시하지 않는다.
2. API와 PC 앱을 함께 재시작한다(`run-app.cmd`). 신규 API의 사진 목록·완료 경로는 SQL 100에 의존하므로 적용 전 사진 기능을 정상으로 표시하지 않는다. 새 PC 클라이언트의 완료 확인과 새 API를 함께 사용한다.
3. Android 자동 갱신은 **0.3.0(versionCode 4) APK** 설치 후 반영된다. 빌드 산출물은 `apps/android-companion/app/build/outputs/apk/debug/app-debug.apk`. 빌드 시 기존 API 주소를 유지했으나 터널 주소의 현재 생존 여부는 검증하지 않았다. 임시 주소가 바뀌면 [휴대폰 테스트 가이드](../../guides/android-phone-companion-test.md)에 따라 테스트 연결과 APK를 다시 생성한다.
4. 기존 APK에서 시각 없는 번호부는 새 버전에서 오래된 것으로 취급한다. 동기화 후 PC 전송을 시험한다. 30분 이상 오래된 번호부는 수신 시·큐 등록 시·전송 전 모두 차단하고 번호부 갱신을 예약한다. 오래된/알 수 없는 번호를 확인하려고 수신 번호를 서버에 보내지 않는다. 통화 자체는 차단하지 않는다.

## 검증 증거 (2026-10-30)

- API 집중: `pnpm --dir apps/api exec vitest run src/supabase/legacy-lists.test.ts src/supabase/rest.pagination.test.ts src/routes/customers.test.ts src/modules/phone/routes.test.ts src/modules/phone/incoming-calls.test.ts src/routes/customer-photos.test.ts src/supabase/customer-photos.test.ts` — **7 files / 56 passed**. 대량 목록 5,003건·서버 페이지 125건, count 없음/외부 조직, VIP/제외 상태, 기존 인증·권한, 사진 완료 라우트 포함.
- PC 집중: `pnpm --dir apps/desktop-react exec vitest run src/features/documents/FilePage.test.tsx src/features/customers/photos/PhotoPanel.test.tsx src/features/phone/IncomingCallAlerts.test.tsx src/platform/tauri.test.ts` — **4 files / 56 passed**. 초안 복원/업로드 busy, 마스킹 IPC, 이동 취소/수락 ACK, 사진 완료/전송 응답 유실 포함.
- Native: `cargo test call_popup --lib --quiet` (`apps/desktop-react/src-tauri`) — **3 passed**. 창별 명령 제한/만료/제한된 요약·이미지 검증. `call_popup_ack`는 main만 허용.
- PostgreSQL: `node scripts/db-tests/customer-photo-upload-100.mjs` — **PASS**. 실제 PostgreSQL 엔진(PGlite), 외부 연결 없음. SQL 재실행·기존 사진 전환·객체 없음/크기/MIME 불일치·완료 멱등·전송 후 강제 종료 복구·130분 만료·member/관리자/다른 조직/비로그인 경계 확인.
- Android: `scripts/build-android-companion.ps1 -ApiBaseUrl <기존 빌드 주소> -UseTcpLoopback -Test`, JDK 21 — **BUILD SUCCESSFUL**, 정책/매칭/릴레이 **9 tests, failures=0, errors=0**. Android SDK XML 도구 버전 경고와 기존 deprecated RoleManager callback 경고는 남으며 빌드는 통과했다.
- API `tsc --noEmit`, PC `build`(타입+Vite) — 통과. 기존 큰 청크 경고는 남는다.
- 독립 읽기 전용 리뷰에서 최초 동기화 동의 철회 경쟁·오래된 번호부 전송·PUT 응답 유실의 세 경계를 추가 발견해 수정했다. 사진 두 회귀는 수정 전 실패/수정 후 성공 확인, 수정 후 재리뷰에서 추가 중요 문제는 보고되지 않았다. 이는 실기기 검증을 대신하지 않는다.

## 제한·다음 단계

- 사진 정리는 고객 사진 목록 조회 시 최대 250개 pending 행을 처리한다. 앱이 실행되지 않으면 DB에서 자동으로 시간에 맞춰 작업하는 스케줄러는 없다. 오래된 미완료 객체의 물리 삭제는 하지 않으며 보유·정리 정책과 분리한다.
- Android는 **전체 번호부의 원자 교체**다. OS 절전/백그라운드 제한으로 주기가 지연될 수 있고, PC 신규 고객이 휴대폰에 즉시 반영된다는 보장은 없다. 증분 버전 API는 아직 추가하지 않았다.
- 화면별 고객 서버 검색·ID 조회 확대와 홈 서버 집계는 대규모 성능 개선 후속이다. 이번에는 잘린 데이터를 정상으로 표시하는 문제를 먼저 막았다.
- 실제 SQL 100 적용/Storage·RLS, Windows 전화 액션, Android 권한/동의 철회·절전과 실제 수신 테스트는 사용자의 운영 흐름 확인 단계에서 수행한다. 전체 제품을 verified로 변경하지 않는다.

참고한 공급자 계약: Supabase의 [서명 업로드 URL](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl)은 2시간 유효하다. 미완료 만료는 이 기간과 10분 여유를 반영하며, API의 `expires_in`도 7,200초로 맞췄다.
