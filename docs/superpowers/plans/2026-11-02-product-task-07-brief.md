# N1030-07 업무별 권한 구현 메모

## 목적

기존 owner/admin/member 역할을 유지하면서 업무 권한을 따로 설정한다. 화면에서 숨기는 데 그치지 않고 일반 API가 Supabase 권한 확인 RPC를 통과해야 쓰기 요청을 처리한다. 소유자 권한은 수정할 수 없고 권한 변경은 같은 트랜잭션에서 감사 기록으로 남긴다.

## 권한 기본값

- owner: 모든 권한 허용. 대상자로 지정하거나 수정할 수 없음.
- admin: 기존 동작과 동일하게 모든 업무 권한 허용.
- member: 고객·예약·시술·수납 조회 허용, 변경/수납/환불/내보내기는 기본 거부.
- 관리자(owner)가 구성원별 override를 저장하면 기본값 대신 해당 업무별 권한을 적용한다. 역할 자체를 변경하거나 멤버십을 제거하지 않는다.

## 권한 코드

`customer.read`, `customer.manage`, `appointment.read`, `appointment.manage`, `treatment.read`, `treatment.manage`, `payment.read`, `payment.collect`, `refund.approve`, `data.export`.

## 변경 범위

- SQL107: 조직/사용자/권한 코드별 override 저장, 역할 기본값 판정 함수, 현재 사용자 권한 목록, owner 전용 override 저장 RPC. 타 조직·owner 대상·허용되지 않은 권한 코드를 거부한다. 설정 변경 audit_events는 트랜잭션 내에 기록한다.
- API: 현재 권한 읽기와 owner 전용 변경 endpoint. `requireAccess`가 기존 구독 기능을 확인한 뒤 적용 가능한 business permission도 확인하며 권한 캐시 키에 permission code를 포함한다.
- React: 구성원 행에서 업무 권한을 열어 조회/업무별 수정/내보내기를 체크하고 저장한다. 실패하면 draft를 보존한다.
- 집중 검증: 기본값과 override, owner 보호, 관리자만 변경, 타 조직 차단, 캐시 무효화, UI 저장/오류 보존.

## 제한

기존 API의 역할 기본 권한과 구독(feature) 검사는 계속 유지한다. 각 모듈의 명시 권한 코드는 위험한 쓰기 동선부터 연결하고, 로컬 파일 내보내기처럼 서버 API를 통하지 않는 동선은 UI가 현재 권한 endpoint를 확인하도록 연결한다. 운영 앱 인수는 별도다.
