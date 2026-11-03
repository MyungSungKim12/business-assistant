# N1030-05 / INT-006 번호부 증분 동기화 요구사항

1~4번의 구현/SQL 검증을 완료한 뒤 순차 착수한다. SQL 번호는 parent가 최신 파일/원격 이력을 보고 확정한다(예상105). 기존 Android 자동 갱신·freshness/동의·계정 generation 보호를 보존한다. 실제 앱/전화 시험이나 원격 SQL 적용은 parent에게 맡기고 집중 검증한다.

## 기능·무결성 계약

1. 조직별 단조 증가 revision, 고객 번호부 관련 변경(name/phone/status/조직·삭제)의 upsert/tombstone 로그, 최소 보존 revision을 제공한다. active/vip만 포함하고 inactive/blocked/archived/무효 번호는 제거 이벤트다. 생일/메모만 바뀐 경우 번호부 전체 전송을 만들지 않는다.
2. **revision은 commit 순서와 일치해야 한다.** 전역 sequence/bigserial을 먼저 발급하고 나중 commit하는 방식은 클라이언트가 낮은 revision의 늦은 commit을 놓칠 수 있다. 조직별 행 잠금/advisory transaction lock 아래 revision 증가·고객/변경 로그 저장을 직렬화한다. 서로 다른 조직은 서로 막지 않게 한다.
3. 초기 전체 동기화의 snapshot revision과 안정적인 keyset을 사용한다. offset으로만 순회하면 도중 삭제/이동으로 행이 빠질 수 있다. 예: bootstrap 시 upper revision을 받고 id keyset으로 그 revision 이하의 현재 live 행을 읽은 뒤, upper 이후 변경을 끝까지 적용하고 한 번에 commit한다. bootstrap 중 수정된 행은 초기 목록에서 빠져도 반드시 후속 delta에 포함되어야 한다. 이름 변경에 의해 keyset 순서가 바뀌게 하지 않는다.
4. 삭제/보관/상태 변경·동일 번호 여러 고객·번호 변경을 정확히 반영한다. 중간 실패 시 기존 번호부/동기화 시각/cursor를 유지하고, 모든 페이지 완료 후 암호화된 payload 한 번으로 entries+revision+synced_at을 원자 교체한다. 같은 변경 재수신은 멱등이다.
5. cursor에 organization과 모드/revision·경계를 포함하고 다른 조직/미래/조작된 값·역전/반복 페이지를 거절한다. 오래되어 로그가 제거된 cursor는 명시적 전체 재동기화로 전환한다. 신규 고객을 찾으려고 모르는 수신 번호를 서버에 업로드하지 않는다.
6. 쿼리와 응답은 페이지 크기/최대 순회/저장 건수·동시 호출·실행 시간을 제한한다. 한도에 닿으면 부분 번호부를 정상 저장하지 않는다. RLS/JWT/조직·crm 기능 권한을 서버와 DB 모두 적용한다.
7. 자동 갱신은 기본적으로 revision 확인/변경분만 가져오고 초기 설치·cursor 만료만 전체 동기화한다. 변경 없음 응답도 정상 서버 확인이면 synced_at을 갱신한다. 장애 시 신선하다고 표시하지 않는다.
8. 동의 철회·로그아웃·계정/매장 전환 중 요청의 late success가 데이터를 되살리지 않도록 저장 직전 generation+동의를 검사한다. 현행 WorkManager 자동 갱신/직렬화·30분 stale 전송 차단을 깨지 않는다. 기존 APK의 초기 directory API도 유지한다.

## 테스트/보고

- org별 commit 순서/late commit hole, bootstrap 중 신규/변경/삭제/이름 순서 변경, 동일 번호 고객, archive/VIP 전환, 무효 번호, 로그 만료 reset·cursor 조작/범위.
- Android initial/delta/tombstone/no-change·중간 실패 rollback·old generation/철회·중복 페이지를 순수 로직/JVM 정책 테스트와 실제 compile로 검증한다. 암호화 store·WorkManager 연결도 소스 대조한다.
- API·격리 PostgreSQL·Kotlin 집중 테스트/타입/빌드만 수행. 전체 테스트/실제 전화·외부 DB 쓰기·커밋/푸시는 하지 않는다.
- 기존 모바일 테스트 게이트웨이의 allowlist에 필요한 최소 읽기 경로만 추가하고 PC-only summary/관리 경로를 열지 않는다.
- SQL/RPC/API/cursor 계약, 실제 새 APK 버전과 변경 파일·명령/결과·미검증 한계를 `docs/product/audits/2026-11-02-phone-directory-incremental.md`에 기록한다. broad product README/changelog/ledger는 parent 소유다.
