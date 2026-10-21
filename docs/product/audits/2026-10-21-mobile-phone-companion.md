# INT-005 모바일 전화 연동 기초 — 2026-10-21

## 구현 범위

- `GET /organizations/:organizationId/mobile/phone-directory`: 활성 고객 중 유효한 전화번호가 있는 행만 페이지로 반환한다. 응답은 고객 ID·이름·원래 전화번호·E.164 번호로 제한한다.
- `POST /organizations/:organizationId/mobile/phone-identification`: 요청 본문 번호를 정규화해 정확히 일치하는 고객만 반환한다. 같은 번호가 중복 등록된 경우 복수 결과를 모두 보존한다. 전화번호가 URL 접근 로그에 남지 않도록 POST 본문을 사용한다.
- `POST /organizations/:organizationId/mobile/phone-memos`: 선택 고객의 조직 및 활성 상태와 번호 일치를 재검사한 뒤 기존 `customer_activities`에 `phone_call` 유형으로 저장한다. CRM 기능 접근이 있는 조직 구성원에게 허용하며 일반 활동 수정·삭제 정책은 바꾸지 않았다.
- 고객관리 화면에 전화번호 확인, 복수 일치 시 고객 선택, 상담 메모 저장을 연결했다. 네트워크 오류에서도 입력 내용이 화면에 남는다.
- 한국 국내/`+82` 및 명시적 국제 `+` 번호를 E.164 형태로 정규화한다. 발신번호 표시 제한, 너무 짧거나 비정상적인 번호는 조회하지 않는다.

## 검증 증거

- `pnpm --filter @business-assistant/api exec vitest run src/modules/phone/phone.test.ts src/modules/phone/routes.test.ts` — API 테스트 14개 통과.
- `pnpm --filter @business-assistant/desktop-react exec vitest run src/features/customers/PhoneMemoDialog.test.tsx` — React 테스트 3개 통과.
- `pnpm --filter @business-assistant/api exec tsc --noEmit` — 통과.
- `pnpm --filter @business-assistant/desktop-react exec tsc -b --pretty false` — 통과.
- SQL 추가 없음. 실제 Supabase·Android·iOS·실기기 테스트는 수행하지 않았다.

## 남은 범위 및 제품 제한

- INT-005는 API/React 기반만 구현되어 `in-progress`다. 고객관리의 수동 메모 UI는 현재 React 데스크톱 화면 안에 있으며 휴대전화 앱 화면은 아니다.
- INT-006은 Android `CallScreeningService`, iOS Call Directory Extension, 앱 그룹/키체인/Keystore 저장, 번호부 동의·동기화 해제·로그아웃·조직 변경 시 삭제, OS 권한/설정 안내를 포함한다.
- 이 Windows 작업공간에는 Android SDK/Java와 Apple Xcode가 없어 Tauri 모바일 프로젝트 생성, Android 패키지 빌드·설치, iOS 확장 서명·빌드·실기기 확인을 할 수 없다. 따라서 자동 발신자 식별은 아직 제공되지 않는다.
- iOS 일반 SIM 통화 이벤트 자동 수집은 제품 범위에서 제외된다. iOS는 Call Directory로 OS 발신자 이름 표시를 제공하고, 메모는 앱에서 사용자가 직접 열어 저장하는 흐름이어야 한다.
- 기존 고객에게 번호가 중복된 경우 메모 저장 전 사용자가 고객을 직접 선택한다. 숨김 번호는 고객과 연결하지 않는다.
