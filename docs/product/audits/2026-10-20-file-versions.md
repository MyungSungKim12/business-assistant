# FILE-11 파일 버전 이력

- 날짜: 2026-10-20
- 상태: 파일 버전·조직/요금제 용량 상한 구현 및 격리 검증 완료, SQL 076/088/090/096 Supabase 적용 대기
- 범위: 기존 파일 버전 1 이관, 새 버전 업로드·게시, 버전별 다운로드, 조직 격리, 멱등 재시도

`file_assets`는 현재 파일 정보를 계속 제공하고, `file_asset_versions`는 각 Storage 경로를 포함한 불변 버전 원장을 보관한다. 기존 파일은 현재 Storage 객체를 옮기지 않고 버전 1로 기록한다. 새 버전은 별도 경로에 먼저 올리고 Storage가 읽을 수 있는 객체로 확인한 뒤 DB RPC로 현재 버전을 교체한다. 파일/버전의 조직 ID와 버전 번호를 다시 확인하며, 이전 객체는 보존한다. 같은 작업 ID의 커밋을 다시 보내면 같은 버전을 반환한다.

파일 화면에서 버전 이력을 열어 이전 버전을 내려받거나 새 버전을 올릴 수 있다. 파일별 50MB 제한은 유지한다. API는 버전 원장의 Storage 경로를 응답에 포함하지 않는다.

2026-10-20 용량 제한 추가: SQL 088/090에서 조직 기본 한도를 5 GiB로 만들고, 실제 `business-files` Storage 객체 바이트와 30분 업로드 예약을 합산해 조직 한도를 검사한다. 조직별 값은 owner/admin이 파일 화면에서 0~1,024 GiB로 조정할 수 있고 파일 화면은 사용량·예약량·잔여량을 보여준다. 낮춘 한도가 실제 사용량보다 작으면 새 업로드가 차단된다. 변경은 감사 이벤트로 남는다. 최초 파일 업로드는 실제 객체 크기를 확인한 뒤 완료 처리하며, 파일 버전 게시도 예약 크기와 Storage 실제 크기가 맞아야 한다. 파일별 50 MiB 제한은 그대로다. 미완료 업로드 예약은 30분 후 만료되며, 실제 객체 정리 정책은 별도 운영 항목이다.

2026-10-20 요금제 한도 추가: SQL 096은 `plans.file_storage_quota_bytes`를 선택적으로 설정할 수 있게 하고, 플랫폼 관리자 구독 화면에 요금제별 한도 입력을 추가한다. 한도 숫자는 미리 채우지 않는다. 각 조직의 실제 상한은 조직 요청 한도와 활성/체험 요금제 상한 중 작은 값이며, 요금제 한도를 비우면 조직별 설정만 적용한다. 실제 Storage 객체 크기 집계 특성에 따라 현재 고객 사진·파일 버전·보관/휴지통 객체를 포함한 조직 prefix 아래 모든 `business-files` 객체를 사용량에 포함한다. 요금제 하향으로 사용량이 상한을 넘더라도 저장 파일을 지우지 않고 새 업로드 예약을 거절한다. 체험 중에도 해당 플랜 상한을 적용한다. 요금제 값은 플랫폼 관리자가 상품 정책 확정 뒤 직접 입력해야 한다.

검증:

- `node scripts/db-tests/file-versions.mjs`: 7개 그룹 통과(실제 Storage 용량, 예약·한도, 업로드 완료·멱등 처리, 크기 불일치, 조직/경로 격리, 원장 변경 차단)
- `pnpm --filter @business-assistant/api test -- src/modules/documents/files.test.ts`: 17건 통과(용량 부족 오류, 조직 범위 예약, 업로드 완료 및 예약 해제).
- `pnpm --filter @business-assistant/desktop-react test -- src/features/documents/FilePage.test.tsx src/features/documents/FileUploadPreview.test.tsx src/features/catalog/catalog.test.tsx`: 64건 통과.
- `node scripts/db-tests/file-storage-plan-quota-096.mjs`: 활성/체험 요금제 상한, 더 낮은 조직 상한, 사용량 초과, 예약·멱등 재시도, 요금제 해지 시 조직 한도 유지 확인.
- `pnpm --filter @business-assistant/api test -- --run src/migrations.file-storage-plan-quota.contract.test.ts src/modules/admin/admin.test.ts src/modules/documents/files.test.ts`: 47건 통과. 요금제 한도 해제(null 저장)와 일반 구성원 변경 차단도 확인.
- `pnpm --filter @business-assistant/desktop-react test -- --run src/features/admin/AdminSubscriptionPage.test.tsx src/features/documents/FilePage.test.tsx`: 32건 통과.
- `pnpm --filter @business-assistant/api build`: 통과.
- API 빌드와 React 빌드 통과. React 빌드의 기존 번들 500 kB 초과 경고는 남아 있다.

제한: 새 조직은 5 GiB 기본값을 적용한다. 요금제별 바이트 값은 정책 결정 전이라 미설정이며 이 경우 조직별 한도만 적용된다. 관리자 UI/API/DB 적용은 SQL 096이 필요하다. 만료된 예약은 사용 가능량에서 빠지지만 연결되지 않은 실제 Storage 객체는 관리자가 별도 정리해야 한다. 외부 공유 링크는 접근·만료·철회 정책이 없어 포함하지 않았다. 실제 Supabase 적용과 운영 계정 Storage 확인은 하지 않았다.
