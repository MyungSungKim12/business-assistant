# 예약·방문과 개별 시술 원장 연결

날짜: 2026-10-20. ID: APT-004 / TRT-001 / TRT-003. 전체 상태는 in-progress를 유지한다. 선행: 기존 예약·방문·시술 원장과 예약→고객별 시술 이력 진입(F09). 사용자는 SQL 064 실행 완료를 보고했다. 원격 DB에 독립 접속해 확인하지 않았으며 실환경 업무 왕복은 미검증이다.

## 이번에 구현·집중 검증한 범위

- 기존 시술 한 건에 nullable `appointment_id`, `visit_id`를 보관한다. 과거 기록은 NULL이며 추정 연결하지 않는다. 한 예약·방문에 여러 시술을 연결할 수 있다.
- 예약 상세의 ‘시술 이력’ 진입에 예약 ID를 전달한다. 해당 고객의 연결된 시술이 있으면 이력을 선택한다. 없으면 기존 기록 선택 또는 새 기록 저장 후 명시적으로 연결한다. 진입만으로 시술·방문·결제는 생성하지 않는다.
- 시술관리에서 기록 선택 → **예약·방문 연결** → 예약 및 기존 방문 선택 → 사유 입력 → 저장한다. 예약 없는 워크인 방문도 가능하다. 연결된 예약과 방문 ID가 시술 화면에 표시된다.
- 방문은 선택한 예약과 일치하는 것만 선택할 수 있다. 예약을 바꾸면 이전 방문 선택을 비운다. 취소·노쇼 예약, 취소 방문의 신규 연결은 거절한다. 종료 방문의 역사 연결은 허용한다.
- 준비·진행 중 기록만 관리자(owner/admin)가 연결·해제할 수 있다. 완료·중단·legacy 기록은 조회만 가능하다. 연결로 시술일·담당자·서비스·금액을 덮어쓰거나 매출을 생성하지 않는다.
- 저장은 기록 버전·operation_id·사유를 검증하며 `visit_link` 이벤트에 이전/이후 원장을 보관한다. 응답 미확인 시 입력을 잠그고 같은 요청으로 재시도한다. 버전 충돌 시 입력을 보존하고 새로고침을 안내한다.
- 조직·고객 복합 FK, 방문/예약의 NULL-safe 일치 검사, DB 권한과 RPC 역할 검사로 잘못된 연결을 막는다. 클라이언트의 새 컬럼 직접 INSERT/UPDATE 권한을 부여하지 않았다.
- 고객 병합의 부모→방문/장바구니→시술/이벤트 이동 순서를 고려해 새 FK와 일치 검사를 지연한다. 연결 RPC는 고객을 먼저 잠가 고객 병합과 경쟁할 때도 범위를 재검증한다.
- 예약·방문 선택지와 시술 이력은 count-exact 페이지 순회로 완전 조회한다. 뒤쪽 연결 기록이 잘려 새 시술이 필요한 것처럼 보이는 문제를 막고, 중간 실패는 부분 성공으로 반환하지 않는다.
- 기존 시술 입력 중에는 연결 창 진입을 막는다. 연결 창의 작성/처리 상태도 공통 이탈 보호에 등록하며 취소 확인과 이전 조직·고객 조회의 늦은 응답 무시를 포함한다.

## 적용할 SQL

Supabase SQL Editor에서 `migrations/064_treatment_visit_link.sql` 전체를 실행한 뒤 API와 앱을 재시작한다. 063까지 적용했다면 추가 실행 대상은 **064 하나**다. 기존 번호를 다시 실행할 필요는 없다.

064는 연결 컬럼·복합 FK·검사 트리거·감사 action 확장·`set_treatment_visit_link` RPC를 추가한다. 기존 `consult`, `service_link` 등 모든 기존 action을 보존한다. 격리 DB에서는 두 번 실행해 재적용도 확인했다. 운영 데이터 변경·자동 연결·이력 삭제는 포함하지 않는다.

## 검증 명령·결과

```powershell
node scripts/db-tests/treatment-visit-064.mjs
# 실제 014/016/017/024/034 + 064 적용, 064 재적용 포함 13개 묶음 통과
pnpm --filter @business-assistant/api exec vitest run src/modules/treatments/visit-link.test.ts src/modules/treatments/treatments.test.ts src/modules/treatments/sale-drafts.test.ts
# 3 files / 162 passed
pnpm --filter @business-assistant/desktop-react exec vitest run src/features/treatments/TreatmentVisitLink.test.tsx src/features/treatments/TreatmentPage.test.tsx src/features/treatments/logic.test.ts src/app/workspace.test.tsx src/features/appointments/AppointmentPage.test.tsx
# 5 files / 135 passed
pnpm --filter @business-assistant/api exec tsc --noEmit
pnpm --filter @business-assistant/desktop-react exec tsc -p tsconfig.app.json --noEmit
# 양쪽 exit 0
```

DB: 동일 요청 재시도/키 재사용/낡은 버전, 다른 조직·고객·member·미인증, 직접 쓰기, 복수 시술, 연결 해제, 워크인, 취소 대상, 부모 방문 변경, 완료 잠금, 고객 이동을 확인했다. React: 명시 저장, 입력 보호, 조회 재시도, 미확인 저장 재시도, 버전 충돌, 조회 전용, 진입값 누락, 이전 응답 무시와 화면 진입 연결을 확인했다. 독립 정적 리뷰에서 중요 결함 지적 없음.

## 남은 범위

- 실제 앱·운영 DB·설치본·전체 테스트는 실행하지 않았다. 화면 캡처 증거 없음. 064 운영 적용과 실사용 인수는 사용자 후속이며, 커밋/푸시하지 않았다.
- 고객 병합은 실제 `merge_customers` 전체 호출 대신 동일한 부모/자식 이동 순서를 격리 DB에서 검증했다. 다른 기능을 포함한 병합 실환경 인수를 대신하지 않는다. 다중 연결 동시성은 별도 PostgreSQL 인수가 필요하다.
- 시술에 연결된 방문을 결제 초안 가져오기의 강제 대상 방문으로 삼는 검사는 아직 추가하지 않았다. 기존 수납 가져오기 동작을 바꾸지 않았다. **다음 우선순위는 결제 초안의 연결 방문 일치·잘못된 장바구니 반영 차단**이다.
- 예약 상태와 시술 상태는 독립이다. 예약 취소·노쇼가 이미 연결된 역사 기록을 삭제하거나 시술 상태를 자동 변경하지 않는다. 상태 연동 정책과 서비스별 필수 동의/시작 시 발행본 고정은 후속이다.
- 조회는 공통 상한(20,000행/100페이지/30초)을 따르며 초과·실패 시 재시도를 안내한다. 검색 전용 서버 페이지 API와 방문/예약의 구체 정보로 돌아가는 추가 탐색은 후속이다.

권한 설계 참고: [Supabase RLS 문서](https://supabase.com/docs/guides/database/postgres/row-level-security). 이 작업은 기존의 클라이언트 직접 변경 금지와 감사 RPC 패턴을 따른다.
