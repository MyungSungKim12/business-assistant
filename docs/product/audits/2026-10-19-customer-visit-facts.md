# 고객 실제 방문·다음 예약 원장 연결

날짜: 2026-10-19. 기능: CRM-011, DASH-002/007, 독립 감사 F10. 선행: 고객·방문·시술·예약 원장과 SQL 060. 상태: in-progress. SQL 060까지 사용자 적용 보고, **061은 준비·격리 검증 상태이며 원격 미적용**이다.

## 변경 범위

- SQL 061의 읽기 전용 `get_customer_visit_facts` RPC와 CRM 배치 API를 추가했다. 요청당 고객 200명, 클라이언트 동시 배치 3개로 제한한다. 고객별 개별 요청은 하지 않는다.
- 최근 실제 방문은 취소되지 않은 방문 원장의 방문 시작일(KST)과 완료 시술일 중 최근 날짜다. 미래 방문·시술은 제외한다. 무예약 방문과 아직 수납하지 않은 실제 방문도 포함하며 환불은 방문 사실을 지우지 않는다.
- 다음 예약은 현재 이후 시작하는 reserved/confirmed 예약 중 가장 이른 시각이다. 취소·노쇼·이미 방문한 예약은 제외한다.
- 재방문 권장일은 최근 완료 시술의 권장일이며 예약과 별개다. 최근 시술에 권장일이 없으면 과거 시술의 권장일로 대신하지 않는다.
- 고객 목록의 최근 실제 방문, 상세의 원장 요약, 임박 예약·장기 미방문 인사이트, 홈의 최근 방문·다음 예약 패널을 연결했다.
- `customers.last_visit_date/next_visit_date` 수기 값은 변경하지 않는다. 계산용 고객 복사본을 편집 폼이나 선택에 넘기지 않는다. 서버 정렬 선택은 아직 수기 필드이므로 ‘수기 최근 방문순’으로 명시했다.
- 오류·SQL 미적용은 미확인으로 표시한다. 수기 날짜를 원장 사실로 대신하거나, 조회 실패를 예약 없음·방문 없음으로 표시하지 않는다. 재시도와 고객 전환의 늦은 응답 무시를 제공한다.

## 집중 검증

실제 앱 실행·전체 테스트·원격 Supabase 접속 없이 아래 범위만 검증했다.

| 명령 | 결과 |
| --- | --- |
| `node scripts/db-tests/customer-visit-facts-061.mjs` | PASS. 취소·미래 원장/노쇼 제외, 완료 시술, 권장일 분리, 수기 보존, 조직·역할·배치·빈 고객·재실행 |
| API `vitest run src/routes/customer-visit-facts.test.ts src/routes/customers.test.ts` | 20개 통과. 인증·CRM 권한·입력·조직/고객 불일치·중복/누락 응답 포함 |
| React `vitest run src/features/customers/visitFacts.test.ts src/features/customers/visitFactsHook.test.tsx src/features/customers/InsightsVisitFacts.test.tsx src/features/customers/CustomerPage.test.tsx src/features/customers/CustomerPageTools.test.tsx src/features/customers/CustomerGridPrivacy.test.tsx src/features/dashboard/DashboardPage.test.tsx` | 49개 통과. 배치/동시성, 늦은 응답, 오류·재시도, 선택 시 수기 보존, 기존 고객·홈 회귀 |
| API `tsc --noEmit`, React `tsc -p tsconfig.app.json --noEmit` | 통과 |

독립 소스 리뷰에서 중요 결함 지적은 없었다. 화면 증거·실환경 왕복 검증은 수행하지 않았으므로 전체 기능 verified 표시는 하지 않는다. 커밋·푸시도 하지 않았다.

## 적용과 제한

1. 060까지 적용한 DB에서 `migrations/061_customer_visit_facts.sql` 전체를 실행한다. 기존 고객 프로필을 갱신하지 않는 조회 함수·인덱스·실행 권한 변경이다.
2. 갱신된 API와 앱을 재시작한다. 적용 전에는 원장 정보가 미확인으로 표시되며 일반 프로필 편집은 유지한다.
3. 실환경에서는 무예약 방문, 취소/노쇼, 완료 시술, 권한별 조회를 추후 확인한다.

대량 고객 화면의 인사이트는 현재 불러온 고객 범위이며 전 매장 집계가 아니다. 원장 기록이 없는 과거 수기 방문을 자동 확정하거나 변환하지 않는다. 화면은 조회 시점 스냅샷이며 실시간 구독은 추가하지 않았다. 시술 원장의 예약/방문 FK 연결(F09 잔여), 대량 목록 완전성(F12), 상태 정정 이력 등은 후속이다.

## 적용 상태 후속 기록

2026-10-19: 사용자가 SQL 061 실행 완료를 보고했다. 위 구현 당시의 원격 미적용 기록은 작업 이력으로 보존하며, 현재는 사용자 적용 보고·독립 원격 확인 및 실환경 검증 대기 상태다.
