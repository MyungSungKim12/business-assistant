# SALE-002 수납 기록 계약 — 2026-10-06

## 동선과 범위
검토 완료 장바구니에서 수납 기록 창을 연다. 현금/카드/이체의 실제 받은 금액을 입력하고 카드 승인번호·이체 식별번호를 기재한다. 받은 사실을 확인한 뒤 저장한다. 외부 단말기에 승인/이체를 요청하지 않는다.

- 금액은 KRW 원 단위 양의 정수 문자열, 소수점 청구는 수납 전에 장바구니에서 정정한다.
- 10만원에 카드7만원+현금3만원, 혹은 3만원 우선 수금 후 잔여7만원 기록을 지원한다.
- 최초 수납 이후 청구 항목과 합계를 동결한다. 이후 수납은 미수 범위만 허용한다. 부분수납 collecting, 완납 paid. 방문은 부분수납 checkout_ready, 완납 closed.
- 동일 operation ID와 동일 사용자/요청은 동일 결과. 동일 키의 다른 입력은 충돌. 버전과 합계는 DB 잠금 안에서 검증한다.
- 각 수납은 불변 영수 행이며 같은 트랜잭션에서 재무 수입행을 생성한다. 수납 연결 재무행은 범용 수정/보관으로 바꾸지 못한다. 환불은 SALE-003에서 별도 역거래로 구현한다.
- 카드/이체 reference는 필수이고 조직·수단별 중복 거부. 현금은 공란 허용. 실제 카드번호/계좌 비밀번호 입력 없음.
- 지갑·포인트·단말기 연동·세금 계산·환불 UI는 제공하지 않는다. 미완료 기능을 수납 완료로 추정하지 않는다.

## API / DB 계약
GET /organizations/{org}/visits/{visit}/payments -> get_visit_payments(org,visit)
POST 동일 경로 -> record_visit_payment(org,visit,expected_version,operation_id,payments,confirmed)
payments: [{method: cash|card|transfer, amount: 양의 정수 문자열, reference: 문자열}], 1..3개, 수단 중복 불가.
응답: visit_id, cart_id, cart_version, total_amount, paid_amount, outstanding_amount, currency='KRW', status=draft|ready|collecting|paid|void, receipts 배열(id,method,amount,reference,received_at,operation_id).
권한: CRM+finance 기능 및 조직 멤버 조회, owner/admin 기록. DB도 회원/관리자 직접 검사. 새 SQL은 025, 선행024 보완본.

## 검증
잘못된 금액/null/권한/다른 조직/과수금/버전충돌/동일키 재시도/카드참조 중복/부분→완납/청구 수정 금지/재무행 수정 금지/실패 전부 롤백, 화면 입력 보호와 모호한 실패 재시도.
