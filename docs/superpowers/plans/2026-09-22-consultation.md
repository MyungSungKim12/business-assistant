# 순차 작업 1 — 상담 초안·주의 확인 (TRT-001)

사용자 요청: 미완료 기능을 하나씩 구현하고 항목 완료 시 진행 알림을 준 뒤 다음 항목 진행. 실행 PC의 회사 보안 정책은 변경하지 않으며 다른 로컬 환경 검증 항목을 남긴다.

## 설계·계약

기존 시술 준비(draft) 기록을 저장한 뒤 상담을 작성한다. 치료 진단이 아닌 서비스 상담 목표/예정 관리 내용이다. goal 최대2000, plan 최대5000; 빈 초안 저장 허용. 주의 확인은 고객의 allergies,skin_type,concerns 스냅샷을 저장하며 클라이언트가 본 값과 최신DB값이 일치할 때만 허용한다. 확인자는 auth.uid(), 확인 시각은 DB. 고객 정보 미등록은 없음으로 해석하지 않고 직원이 직접 확인한다.

DB017: treatment_records에 consultation_goal/consultation_plan text default'', cautions_snapshot jsonb default{}, cautions_acknowledged_by uuid nullable, cautions_acknowledged_at timestamptz nullable 추가. 기존 생성/일반 편집 API의 필드는 그대로 유지한다.

기존 mutate_treatment RPC action consult 추가. values 정확히 {goal,plan,acknowledge_cautions,expected_cautions}. expected_cautions는 {allergies:str,skin_type:str|null,concerns:list[str]}. consult는 draft에서만 가능. expected_version/operation_id/권한/원자적 감사 스냅샷/재시도 보호는 기존과 동일. 감사 action consult 허용.

start는 상담목표 비공백+주의확인+현재 고객 주의정보와 스냅샷 동일할 때 허용. 기존 작업 replay는 결과 재사용하고 새 변경은 재확인 요구. 기존 상태 legacy/in_progress/completed/cancelled를 임의 전환하거나 소급 확인하지 않는다.

화면: 별도 상담 다이얼로그(목표/예정관리/고객 주의정보/확인 체크/저장). 조회는 모든 상태, 편집은 관리권한+draft만. 별도 비동기 저장, 실패 입력유지, 취소/닫기 미저장 보호, 동일요청 retryID유지. 성공하면 부모 시술기록/버전 갱신. 읽기상태/확인자·시각 표시. 시술 시작 전 부족한 상담을 안내하고 서버에서도 검사.

## 순서·소유

- [x] DB017 및 격리 PostgreSQL 테스트: DB 담당.
- [x] 서버DTO/API/저장소/요청검증과 테스트 작성: 서버 담당. 실행은 대기.
- [x] 데스크톱 모델/상담UI/부모연결과 테스트 작성: 주 담당. 실행은 대기.
- [x] 정적검사·가능한 격리검증·문서. 별도 검토는 부분 수행. Python SSL/_queue 정책 차단을 우회하거나 성공으로 보고하지 않음.
- [x] 1항목 코드 완료 알림 후 동의 문서 템플릿/버전 최소기능(DOC-001) 진행.
- [ ] 다른 PC Python/API/Qt 및 실제 Supabase 검증 후 verified 판정.

기존 미커밋 작업을 보존하고 같은 작업 디렉터리에서 이어감. 실DB/발송/커밋/배포 없음. 확인하지 않은 UI/서버 테스트는 pending verification으로 문서에 기록.
