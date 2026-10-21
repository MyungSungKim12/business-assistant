# TEAM-11 / LAB-10 수당 정산·경영 손익 연결

## 구현

- SQL 079에 거래 이벤트 기준 수당 미리보기, 기간 확정, 확정 스냅샷과 재시도 키를 추가했다. 거래 이벤트는 현금/카드/이체 수납, 금액형 회원권 사용, 환불이다. 반품 환불과 회원권 사용 환불은 원래 판매 항목에 직접 연결하며 일반 환불은 활성 항목 금액 비율로 배분한다.
- 항목 할인은 기존 `sale_cart_line_discount` 산식을 사용한다. 수납 이벤트 금액은 할인 후 항목 금액 비율로 나누고 생성 순 마지막 항목에서 원 단위 반올림 잔액을 맞춘다. 시행일 기준 규칙 중 직원별 규칙이 기본 직원 규칙보다 우선한다.
- 실제 담당 직원·유효 규칙이 없는 항목은 경고하고 확정을 막는다. 확정은 지난 날짜만 허용하며 겹치는 기간을 차단하고, 확정 원장·규칙 스냅샷은 수정하지 않는다. 같은 operation ID 재시도는 기존 확정 결과를 돌려준다.
- 직원은 직원 레코드에 연결된 계정의 자기 수당 항목만 조회한다. 관리자는 전체 정산을 본다. 장바구니 담당자는 조직 로그인 구성원에 연결된 직원만 선택할 수 있게 했다.
- LAB-10은 조회 기간 전체의 정산이 완료되면 해당 거래일의 수당을 운영 잔액에서 차감해 세전 잔액으로 표시한다. 기간 중 일부만 확정됐거나 원가가 미확인인 경우 계산을 보류한다. 세금 계산을 제공하지 않으므로 `is_final_profit`는 계속 false다.

## 검증

- `npm run test:commission-settlements --prefix scripts/db-tests`: 격리 PGlite에서 수납·환불 음수 조정, 수당액, 재시도, 기간 잠금, 직원 범위, 수당 차감 손익을 확인했다.
- `pnpm --filter @business-assistant/api test -- management.test.ts`: 12개 API 집중 테스트 통과. 미리보기/확정 관리자 권한과 직원 열람 경로 확인.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/management/ManagementPage.test.tsx src/features/sales/SalesPage.test.tsx`: 23개 화면 테스트 통과.
- `pnpm --filter @business-assistant/api build`, `pnpm --filter @business-assistant/desktop-react build`: 통과. React 빌드에 기존 청크 크기 경고가 남아 있다.

## 제한과 적용

- SQL 079는 Supabase 미적용이며, 사용자는 현재 065까지 적용 완료라고 보고했다. 운영 적용은 066부터 079까지 빠짐없이 순서대로 필요하다.
- 시술 수당은 `treatment_records.appointment_service_id` 또는 시술 초안의 서비스 ID가 존재해야 해당 서비스 규칙에 연결된다. 과거 자료에서 서비스 연결이 없으면 미지정 경고가 발생한다.
- 정산 전에 실제 직원·규칙 설정을 완료해야 한다. 장바구니 담당이 비어 있거나 전체 직원 기본 규칙도 없으면 확정할 수 없다.
- 정산된 수당을 세금 신고액이나 급여 지급으로 간주하지 않는다. 급여·세금, 인센티브 외 고정급, 지급 완료 상태는 범위 밖이다.
- D-10의 개인정보 파기 보류는 그대로 유지했다.


## 2026-10-20 후속 — 직원별 정산 성과 집계

직원 화면에 확정 정산 기간 선택과 직원별 정산 항목 수·환불 건수·순 수납 배분액·확정 수당 합계를 추가했다. 환불은 음수 원장 값을 그대로 합산한다. 선택한 확정 정산 하나만 사용하며 최신 종료 기간을 기본 선택한다. 직원 계정 연결 시 서버가 제한한 본인 항목만 들어온다. 조회 오류를 “확정 정산 없음”으로 숨기지 않는다.

- React `pnpm --filter @business-assistant/desktop-react test -- src/features/management/commissionPerformance.test.ts src/features/catalog/StaffPage.test.tsx`: 6개 통과. 집계 함수의 기간 격리·환불 합산·담당 미지정 보존과 화면의 정상/오류 상태를 확인했다.
- 실 Supabase 역할 검증과 앱 실행은 하지 않았다. 복수 담당자 배분·급여·세금은 추가 기능이며 본 집계는 공식 급여 자료가 아니다.

## 2026-10-20 후속 — 환불 발생일 수당 규칙 적용

기존 계산은 환불일에 기록된 음수 수당을 해당 결제 수납일의 규칙으로 계산하고 있었다. 정책은 거래 발생일별 규칙 적용이므로, 환불 또한 환불 발생일의 유효 규칙을 적용하도록 SQL 079를 바로잡았다. 회귀 검증은 1월 10일까지 10%, 1월 11일부터 20%인 규칙과 1월 11일 환불을 만들어 환불 조정이 400원 음수로 계산되는 것을 확인한다.

- `node scripts/db-tests/commission-settlements.mjs`: 통과. 환불일 적용 규칙, 수당 합계, 재시도, 기간 잠금 및 직원 열람 범위를 확인했다.
- 이 수정은 아직 적용하지 않은 SQL 079에 반영되어 있다. SQL 079를 이미 실행한 환경은 해당 함수를 다시 배포해야 한다. 운영 DB에는 적용하지 않았다.

## 2026-10-20 후속 — 담당 누락 귀속 보정 (SQL 093)

수당 미리보기에서 담당 직원이 비어 있는 판매 라인은 기간 정산을 막고 있었지만, 점주가 미리보기에서 직접 원인을 정정할 수 없었다. SQL 093은 별도 override 상태와 변경 불가 이벤트 이력을 추가한다. 점주/관리자는 활성 직원을 선택하고 사유를 입력하며, API가 조직 관리자 권한을 검사한다. 보정 후 기존 규칙과 원래 발생일을 사용해 수당 미리보기를 다시 계산한다. 판매 라인의 원래 담당자 데이터와 수당 금액은 직접 수정하지 않는다.

- SQL RPC는 조직 내 활성 직원·활성 판매 라인, expected version, operation ID, 필수 사유를 검증한다. 이미 확정된 정산 라인은 보정 불가다. operation ID 재시도는 동일한 결과를 돌려주고 같은 키를 다른 입력에 재사용하면 충돌한다.
- `node scripts/db-tests/commission-settlements.mjs`: 통과. 최초 귀속, 재시도 중복 방지, operation 충돌, 낡은 version, member 권한 거절, 원 판매 라인 보존, 불변 이력, 확정 후 변경 차단, 기존 기본 수당 규칙 재계산과 확정 재시도 응답을 확인했다.
- `npm test -- --run src/modules/management/management.test.ts` (apps/api): 17건 통과. 관리자 route, 엄격한 입력, 조직 응답 검증과 finance 관리자 전용 직원 목록을 확인했다.
- `pnpm test -- --run src/features/management/ManagementPage.test.tsx` (apps/desktop-react): 18건 통과. 직원/사유 입력, 저장 후 재조회 경로를 확인했다.
- `npm run build` (apps/api), `pnpm build` (apps/desktop-react): 통과. React 빌드에는 기존 큰 청크 경고가 남아 있다.
- 이 093 귀속 보정 기능은 당시 Supabase 적용 대기였다. 이후 추가된 복수 담당 배분은 [094 감사 기록](2026-10-20-staff-commission-splits.md)을 본다. 사용자가 보고한 최신 적용 번호가 065라면 현재는 SQL 066~094를 순서대로 적용해야 한다. 실제 권한과 원격 스키마 적용은 이 기록에서 확인하지 않았다.
- 관리자 화면에서 불변 수정 이력 전체를 조회하는 UI, 복수 직원 배분, 급여·세금 계산 및 지급은 별도 작업으로 남는다.
