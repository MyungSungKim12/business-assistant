# 대량 발주·파일 목록 완전성 보완

날짜: 2026-10-19. 기능: INV-11 / FILE-11, 독립 감사 F12. 선행: 기존 발주·파일·폴더 테이블과 API. 상태: in-progress. **SQL 061까지 적용했다는 사용자 보고를 기록했으며 이번 작업에 새 SQL은 없다.** 원격 DB에는 접속하지 않았다.

## 재현과 변경

기존 코드는 발주서·발주 품목·공급처·파일·폴더를 한 번 SELECT했다. Data API의 max_rows가 실제 데이터보다 작으면 일부만 읽어도 전체 목록처럼 반환했다. 발주서와 품목의 페이지가 다르게 잘리면 품목이 없는 발주서로 보일 수 있었다.

공통 `Rest.selectAll`을 추가해 기존 배열 응답과 화면 구성을 유지했다.

- `Prefer: count=exact`, 요청 크기 250행, 실제 응답 길이만큼 offset을 이동한다. 짧은 응답을 마지막 페이지로 추정하지 않는다.
- Content-Range의 시작·끝·전체 건수를 본문 길이와 대조한다. 총건수 변경, 미확정/누락 범위, 중복 ID, 진전 없는 페이지, 형식 오류와 중간 HTTP 실패는 부분 성공 대신 오류다.
- 정렬 마지막 키를 유일한 id로 고정한다. 모든 페이지에 조직 필터와 사용자 토큰을 유지하고 게이트웨이에서 반환 조직도 재검사한다.
- 최대 20,000행·100페이지·30초다. 먼저 도달한 제한을 넘으면 503으로 실패한다. 작은 서버 상한에서는 20,000행보다 적어도 페이지 제한에 걸릴 수 있다. 불완전한 목록을 성공으로 표시하지 않는다.
- 발주서/품목은 Map으로 결합하고 부모 없는 품목은 거절한다. 반복 filter 결합도 제거했다.
- 파일의 보관 포함/제외, 내부 storage_path 비노출을 유지한다. 폴더 조회 실패를 빈 목록으로 바꾸던 클라이언트 catch를 제거해 기존 오류·재시도 경로로 전달한다.

계약 근거: [PostgREST Pagination and Count](https://docs.postgrest.org/en/stable/references/api/pagination_count.html), [Supabase range](https://supabase.com/docs/reference/javascript/range). 공식 changelog도 확인했으며 이번 REST 조회 계약에 관련된 추가 변경은 적용하지 않았다.

## 검증 증거

실제 앱·운영 DB·전체 테스트는 실행하지 않았다.

| 명령 | 결과 |
| --- | --- |
| API `vitest run src/supabase/rest.pagination.test.ts src/modules/largeLists.test.ts src/modules/documents/files.test.ts src/modules/catalog/catalog.test.ts src/modules/catalog/catalog.admin.test.ts` | 100개 통과 |
| React `vitest run src/features/documents/FilePage.test.tsx src/features/catalog/PurchaseOrdersDialog.test.tsx` | 17개 통과 |
| API `tsc --noEmit` | 통과 |
| React `tsc -p tsconfig.app.json --noEmit` | 통과 |

페이지 수집 테스트 11개의 선행 실패→구현 후 통과, 폴더 조회 실패가 숨겨지는 React 재현 실패→수정 후 통과를 확인했다. 추가로 서버 상한이 요청보다 작은 경우, 정확한 빈 목록, 중간 실패, count/range 오류·누락·변경, 중복 ID, 페이지/시간 제한, 조직 혼입, 부모 없는 품목을 검사했다. 파일 1,201개와 발주 품목 1,203개에서 마지막 행까지 반환되는 것도 확인했다. 독립 소스 리뷰의 중요 지적은 없었다.

화면 증거 없음, 실환경 검증 미수행, 커밋·푸시 없음. 전체 기능 verified 표시는 하지 않는다.

## 남은 한계와 다음 순서

- 현재 화면과 배열 API 호환을 위한 내부 페이지 순회다. 서버 페이지 UI, total/has_more 공개 응답, 대량 내보내기 작업 큐는 추가하지 않았다. 상한을 넘는 매장에는 별도 페이지 계약이 필요하다.
- 여러 HTTP 요청은 단일 DB 스냅샷이 아니다. 총건수·중복·범위 이상은 거절하지만 동시 변경이 같은 건수를 유지하며 정렬 위치를 바꾸는 모든 경우를 탐지할 수는 없다. 발주서/품목도 서로 다른 조회 시점이다. 일관된 시점 보장이 필요하면 묶음 RPC나 커서/스냅샷 계약으로 확장한다.
- 이번 적용 대상 외 문서·시술 등 모든 목록이 해결됐다고 주장하지 않는다. 보관/폴더 변경이 진행 중인 실데이터 왕복과 성능 측정도 후속이다.
- 다음 감사 우선순위는 F13 노쇼 사유·예약 상태 변경 이력 보존이다.
