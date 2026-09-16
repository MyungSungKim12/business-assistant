# 매출·지출 관리 모듈 설계

## 목적

조직별 수입·지출 거래를 기록하고 기간별 합계를 조회하는 범용 재무 기반을 제공한다. 1차 버전은 거래 원장과 월별 집계 API에 집중하며, 영수증 파일·세금계산서·결제 연동은 후속 모듈로 분리한다.

## 범위

포함하는 기능:

- `finance.basic` 기능키 기반 메뉴·API 접근 제어
- 조직별 수입·지출 거래 생성·조회·수정·보관
- 거래 유형(`income`, `expense`), 금액, 거래일, 카테고리, 거래처, 메모 관리
- 기간 필터와 월별 수입·지출·순액 집계
- Supabase RLS를 이용한 조직 테넌트 경계 보호

제외하는 기능:

- 영수증 파일 업로드와 Storage 연동
- 카드·은행·결제대행사 자동 수집
- 세금계산서 발행과 부가세 신고
- 복식부기 계정과목·재고 원가 회계

## 데이터 모델

### `finance_transactions`

- `id uuid primary key`
- `organization_id uuid not null references public.organizations(id)`
- `transaction_type text not null` (`income`, `expense`)
- `amount numeric(14, 2) not null check (amount > 0)`
- `transaction_date date not null`
- `category text not null`
- `counterparty text not null default ''`
- `memo text not null default ''`
- `is_archived boolean not null default false`
- `created_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default timezone('utc', now())`
- `updated_at timestamptz not null default timezone('utc', now())`

금액은 부동소수점이 아닌 `numeric(14, 2)`로 저장한다. 거래 유형·금액·거래일·카테고리는 데이터베이스 제약과 API 모델에서 함께 검증한다.

## API

모든 엔드포인트는 Bearer JWT, 조직 멤버십, `finance.basic` 기능 권한을 순서대로 확인한다.

- `GET /api/v1/organizations/{organization_id}/finance-transactions`
- `POST /api/v1/organizations/{organization_id}/finance-transactions`
- `PATCH /api/v1/organizations/{organization_id}/finance-transactions/{transaction_id}`
- `GET /api/v1/organizations/{organization_id}/finance-summary`

거래 목록은 `from_date`, `to_date`, `transaction_type` 선택 필터를 지원한다. 날짜 범위가 뒤집히거나 금액이 0 이하인 입력은 422로 거부한다. 생성·수정은 owner/admin 역할만 허용하고 member는 조회와 집계만 허용한다. 삭제 대신 `is_archived` 변경을 사용한다.

집계 응답은 요청 기간과 함께 `income_total`, `expense_total`, `net_total`, `transaction_count`를 반환한다. 집계는 조직 ID와 날짜 조건을 모두 포함한 단일 쿼리로 수행할 수 있도록 인덱스를 둔다.

## 권한과 RLS

- `finance.basic`가 없는 구독은 API에서 403을 반환한다.
- 조직 멤버십이 없는 사용자는 거래와 집계를 확인할 수 없다.
- `finance_transactions`에 RLS를 활성화한다.
- SELECT는 owner/admin/member, INSERT/UPDATE는 owner/admin 역할만 허용한다.
- `organization_id`와 `created_by`는 UPDATE 트리거로 불변 처리한다.
- 물리 삭제 정책은 제공하지 않는다.

## 구현·검증 기준

- 고객·작업·문서 모듈의 인증, 기능 권한, 조직 저장소 패턴을 재사용한다.
- PostgREST 어댑터는 publishable key와 현재 사용자 JWT만 사용한다.
- Decimal 금액 직렬화, 날짜·유형·금액 검증, 기간 집계, RLS 마이그레이션 계약 회귀 테스트를 추가한다.
- 기존 전체 품질 검사와 신규 재무 모듈 테스트가 모두 통과해야 한다.

