# 시술 전 고객 주의사항·동의 문서 확인

날짜: 2026-10-20. 기능 ID: TRT-001 / TRT-003 (전체 in-progress 유지). 선행: CRM 고객 프로필, 상담 주의 스냅샷, DOC 발행본·이벤트·증빙 API. 추가 SQL 없음. SQL 063까지 사용자 적용 보고 상태를 유지한다.

## 구현·집중 검증한 범위

- 시술 이력 선택 → **시술 전 확인** → 최신 고객 주의사항·고민·피부 타입·상담 목표와 확인자/시각 표시. 미등록을 ‘없음’으로 처리하지 않고, 상담 당시 스냅샷과 다르면 재확인을 안내한다.
- 고객·상담과 문서는 독립 조회한다. 고객 조회 실패가 문서 이력을 숨기지 않고 문서 권한/조회 실패를 ‘발행 이력 없음’으로 표시하지 않는다. ‘최신 정보 다시 확인’으로 재조회한다.
- 발행 문서의 제목·서식 버전·발행 시각을 표시한다. 문서를 선택할 때만 이력과 해당 서명 증빙을 조회하므로 발행본 수만큼 자동 호출하지 않는다.
- 손서명 있음/없음, 교부 기록, 철회 기록, 서명 증빙 일치/불일치/증빙 없음/방식 미지원/검증 실패를 구분한다. 철회는 이전 손서명보다 우선 표시한다. 단순 발행이나 해시 일치를 ‘동의 완료’로 묶지 않는다.
- 상담·주의 확인 창과 기존 문서 발행·서명 창으로 연결했다. 조회 자체는 확인 행위·시술 상태·동의 링크를 저장하지 않는다. 기존 시작 조건과 서버 권한 검사를 유지한다.
- 저장하지 않은 시술 입력이 있으면 진입을 막는다. 조직·고객·시술 변경 시 결과를 초기화하고 이전 조회 응답을 무시한다. 선택 문서를 바꾸거나 재선택하면 이전 증빙 결과가 덮어쓰지 않는다.
- API의 발행본·동의 이벤트 조회를 count-exact 완전 조회로 바꿨다. 짧은 페이지를 마지막으로 단정하던 방식에서 뒤쪽 철회가 누락되는 회귀를 재현·수정했다. 조직/고객/시술 일치, 이벤트 revision 연속성, ID 중복과 총수 검증을 유지한다. 페이지 중간 실패는 503이며 일부 이력을 성공으로 반환하지 않는다.

## 검증 증거

```powershell
pnpm --filter @business-assistant/desktop-react exec vitest run src/features/treatments/TreatmentPreflight.test.tsx src/features/treatments/TreatmentPage.test.tsx src/features/treatments/logic.test.ts src/features/documents/Issuance.test.tsx src/features/documents/Evidence.test.tsx
# 5 files / 94 passed
pnpm --filter @business-assistant/api exec vitest run src/modules/documents/preflightPagination.test.ts src/modules/documents/consent.test.ts src/modules/documents/evidence.test.ts src/modules/documents/documents.test.ts src/modules/treatments/treatments.test.ts
# 5 files / 243 passed
pnpm --filter @business-assistant/desktop-react exec tsc -p tsconfig.app.json --noEmit
pnpm --filter @business-assistant/api exec tsc --noEmit
# 양쪽 exit 0
```

React 새 확인 창 14개 + 기존 시술 화면 연결 1개, API 새 페이지 회귀 3개를 포함한다. 기존 손서명 테스트의 jsdom canvas 미지원 안내가 있으나 관련 테스트는 통과했다. 독립 정적 리뷰 중요 지적 없음.

## 제한·다음 단계

- 실제 앱을 띄우지 않았으므로 화면 캡처 증거 없음. 운영 Supabase·실계정 권한·설치본·전체 테스트·커밋/푸시를 수행하지 않았다. 실제 업무 인수는 후속이다.
- 이 조회는 같은 DB 트랜잭션의 고정 시점 스냅샷이 아니다. 새로고침 시각 이후 다른 PC에서 정보가 바뀔 수 있다. 기존 시작 RPC가 최종 상태·버전·주의 확인 조건을 검사한다.
- 공통 완전 조회는 20,000행/100페이지/30초 상한을 따른다. 실패를 부분 성공으로 숨기지 않으며 대량 이력의 서버 검색·요약 전용 API는 별도다.
- 현재 고객 프로필은 기존 고객 목록 API에서 찾아 읽는다. 단건 고객 조회와 서버 측 준비 요약 API는 후속 최적화 범위다.
- 서비스별 필수 동의서 정책, 시술 시작 시 특정 발행본/버전의 원장 고정 및 원자 검사는 추가하지 않았다. 해당 범위를 완료로 표시하지 않는다.
- 다음 기능 연결 우선순위는 예약/방문과 개별 시술 원장 연결이다. 기존 고객별 이력 진입과 개별 원장의 예약·방문 FK는 구분한다.
