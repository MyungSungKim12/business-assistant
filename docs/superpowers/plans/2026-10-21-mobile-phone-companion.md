# Android·iOS 전화 고객 연결 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Android에서 수신 발신자를 로컬 고객 색인으로 식별하고, Android/iOS 동반 앱에서 고객 상담 메모를 저장한다.

**Architecture:** Fastify는 CRM 권한을 확인하는 최소 전화번호부 동기화·번호 조회 API를 제공하고, 기존 고객 활동 API를 통해 메모를 저장한다. Tauri/React는 모바일 대상 UI와 로컬 전화번호부 설정을 제공하며, Android CallScreeningService와 iOS Call Directory는 각각 네이티브 OS 계약을 따르고 서로 다른 자동화 범위를 UI에 명시한다.

**Tech Stack:** React 19, TypeScript, Tauri 2, Node/Fastify, Supabase/PostgREST, Android Kotlin CallScreeningService, iOS Swift Call Directory Extension.

**Spec:** [2026-10-21-mobile-phone-companion-design.md](../specs/2026-10-21-mobile-phone-companion-design.md)

## Global Constraints

- Android 전화 이벤트에 대한 통화 허용 응답은 즉시 제공하고, 네트워크 실패로 통화를 지연하거나 차단하지 않는다.
- 모바일 전화번호부 응답에는 고객 ID, 이름, 전화번호, 상태만 포함한다.
- API와 고객 활동 저장은 조직 `crm.basic` 권한을 서버에서 검사한다.
- iOS SIM 통화의 자동 이벤트 감지/기록을 약속하지 않는다.
- 사용자가 동기화를 끄거나 로그아웃·조직 전환하면 로컬 전화번호부를 지운다.
- 기존 미커밋 작업은 보존하며 커밋·실 Supabase 변경을 하지 않는다.

## Review Focus

- 국제번호, 국가번호 접두, 하이픈/공백 및 빈/비공개 번호 처리: 번호 정규화 테스트.
- 같은 전화번호의 복수 고객: 모호성 유지 테스트.
- 다른 조직/CRM 미가입 사용자: API 권한 및 조직 경계 테스트.
- 일부 페이지 로드 실패/오래된 캐시: 불완전한 전화번호부를 성공으로 표시하지 않는 테스트.
- Android/iOS 로그아웃·조직 전환·동기화 끄기: 로컬 데이터 삭제 테스트.

---

### Task 1: 번호 정규화·일치 계약

**Files:** Create `apps/api/src/modules/phone-integration/phoneNumber.ts`; Test `apps/api/src/modules/phone-integration/phoneNumber.test.ts`.

- [x] RED/GREEN: 한국 국내·+82·국제 `+` 표기와 비공개/잘못된 번호를 다루는 정규화 테스트·헬퍼 구현.
- [x] 검증: `pnpm --filter @business-assistant/api exec vitest run src/modules/phone/phone.test.ts` 통과(10 tests).

### Task 2: CRM 전화번호부 API

**Files:** Create `apps/api/src/modules/phone-integration/routes.ts` and its test; Modify `apps/api/src/supabase/customers.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/customers.ts` only as needed.

- [x] RED/GREEN: CRM 권한·조직 범위가 필요한 최소정보 번호부, 정확 번호 조회, 멤버 통화 메모 경로 구현. 조회 번호는 접근 로그에 남지 않도록 POST 본문을 사용한다.
- [x] 검증: `pnpm --filter @business-assistant/api exec vitest run src/modules/phone/phone.test.ts src/modules/phone/routes.test.ts` 통과(14 tests); API `tsc --noEmit` 통과.

### Task 3: React 동반 앱 전화 메모 흐름

**Files:** Create `apps/desktop-react/src/features/phone-companion/PhoneMemoPage.tsx`, `api.ts`, schema/test files and mobile styles; Modify `apps/desktop-react/src/api/client.ts`, schemas, workspace/shell only for an explicit mobile route or customer activity entry.

- [x] RED/GREEN: 고객관리에서 전화번호로 확인·복수 일치 고객 선택·통화 메모 저장 UI를 연결했다. 실패 시 입력값을 유지한다.
- [x] 검증: `pnpm --filter @business-assistant/desktop-react exec vitest run src/features/customers/PhoneMemoDialog.test.tsx` 통과(3 tests); `pnpm --filter @business-assistant/desktop-react exec tsc -b --pretty false` 통과.

### Task 4: Tauri 모바일 기반과 보안 저장 경계

**Files:** Modify `apps/desktop-react/src-tauri/Cargo.toml`, Rust credential/config modules, Tauri mobile config/capabilities; Add platform secure-store bridges as required by generated targets.

- [ ] RED: 플랫폼별 secure store 인터페이스와 동기화 끄기/로그아웃 초기화를 검증하는 Rust/TypeScript 테스트를 추가한다.
- [ ] GREEN: Windows 키링 설정이 모바일 빌드를 막지 않게 cfg로 분리하고 Android Keystore/iOS Keychain 기반 토큰 저장 및 최소 전화번호부 캐시를 구현한다.
- [ ] 검증: 가능한 host tests 통과; Android/iOS 빌드는 플랫폼 도구가 존재하는 경우에만 수행하고 없으면 정확히 미검증으로 기록한다.

### Task 5: Android CallScreeningService

**Files:** Create Tauri Android native service, manifest, cached directory lookup and event-to-app handoff under generated Android target; tests for number match and non-blocking response.

- [ ] RED: unknown, duplicate, hidden caller, unavailable cache에서도 통화를 허용하는 Kotlin 테스트를 먼저 작성한다.
- [ ] GREEN: Android 기본 통화 선별 역할이 허용된 경우 로컬 조회로 발신자를 표시하고, 전화 응답을 먼저 완료한 후 앱 메모 화면으로 안전하게 이동한다.
- [ ] 검증: Android unit test 및 `tauri android build` 가능할 때 수행. 플랫폼 빌드 환경 부재 시 미검증으로 기록한다.

### Task 6: iOS Call Directory Extension

**Files:** Create Tauri iOS extension source, App Group cache reader, refresh/status bridge and manual call-memo deep link under generated iOS target.

- [ ] RED: 정렬·중복 번호 제거·동기화 해제 후 제거 요청과 빈 데이터 동작을 테스트한다.
- [ ] GREEN: 동기화된 전화번호부를 Call Directory에 로드하고 식별 확장을 갱신한다. 콜 이벤트 자동 수집은 만들지 않는다.
- [ ] 검증: Swift tests / Xcode build / 실기기 통화 확인은 macOS/Xcode/서명 자격이 있을 때 수행한다. 없으면 미검증으로 명시한다.

### Task 7: 문서 상태와 플랫폼 한계 기록

**Files:** Modify `docs/product/README.md`, `docs/product/modules/integrations.md`, `docs/product/backlog.md`, `docs/product/changelog.md`; Create focused audit under `docs/product/audits/`.

- [x] API/React 증거와 플랫폼 툴체인 제한을 changelog 및 감사 기록에 반영했다.
- [ ] 네이티브 구현/설치 가이드: INT-006 진행 단계에서 Android SDK 및 macOS/Xcode 환경 확보 후 작성·검증한다.
