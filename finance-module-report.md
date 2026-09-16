# 매출·지출 모듈 구현 보고서

## 구현 내용

- `finance.basic` 권한 기반 거래 원장 API를 추가했다.
- 조직별 `finance_transactions` 테이블과 거래일·유형 복합 인덱스를 추가했다.
- 수입·지출 거래 목록, 생성, 수정 API를 추가했다.
- 기간 및 거래 유형 필터와 수입·지출·순액·건수 집계를 제공한다.
- 금액은 Decimal과 `numeric(14, 2)`로 처리하고 0 이하·소수점 초과 입력을 거부한다.
- member는 조회·집계, owner/admin은 생성·수정이 가능하다.
- 조직 ID와 작성자 변경을 UPDATE 트리거로 차단하고 RLS를 적용했다.

## API

- `GET/POST /api/v1/organizations/{organization_id}/finance-transactions`
- `PATCH /api/v1/organizations/{organization_id}/finance-transactions/{transaction_id}`
- `GET /api/v1/organizations/{organization_id}/finance-summary`

## 후속 범위

- 영수증 파일 업로드
- 카드·은행·결제대행사 자동 수집
- 세금계산서와 부가세 신고
