# INV-11 상품 분류·바코드 — 2026-10-20

## 구현 범위

- 상품별 분류는 1~80자이며 기본값은 `기타`다.
- 상품 바코드는 비어 있으면 null로 저장하고, 같은 조직 안에서만 중복을 막는다. 같은 바코드를 다른 조직이 써도 서로 영향을 주지 않는다.
- 저장은 owner/admin 전용 RPC에서 조직·버전·operation ID를 검사한다. 일반 판매 조건 저장과 별도 버전 변경으로 기록한다.
- 상품 표에서 분류·바코드를 표시하고, 이름·SKU·분류·바코드 검색과 분류 필터를 제공한다.

## 검증과 적용 상태

- 격리 PostgreSQL: `npm run test:purchase-orders --prefix scripts/db-tests`에서 067 저장·재시도·버전 충돌·조직 내 중복 거절·member 권한 거절을 확인한다.
- API: `pnpm --filter @business-assistant/api test -- src/modules/catalog/catalog.test.ts`에서 067개 요청 검증·권한·RPC 응답 조직 경계를 확인한다.
- React: `pnpm --filter @business-assistant/desktop-react test -- src/features/catalog/catalog.test.tsx`에서 분류/바코드 저장과 바코드 검색을 확인한다.
- API 빌드와 가이드 링크 검사를 통과해야 한다. 실제 Supabase 실행·Tauri 화면 왕복은 확인하지 않았다.
- `migrations/067_catalog_category_barcode.sql`은 066 뒤에 실행해야 하며 아직 실 DB 미적용이다.

## 제한

바코드 스캔 보완(2026-10-20): 재고 목록에 USB HID 키보드 방식 스캐너 입력란을 추가했다. 바코드 뒤 Enter를 보내면 조직의 상품 목록에서 완전 일치하는 항목을 열고, 미등록 값·중복 값은 오류로 안내하며 임의의 항목을 선택하지 않는다. 검색·분류·재고 필터에 가려진 항목도 찾을 수 있도록 필터를 해제한다. 미저장 상품 편집은 기존 보호 확인을 거친다. 카메라 기반 스캔과 입력 자동 초점은 포함하지 않았다. `pnpm --filter @business-assistant/desktop-react test -- src/features/catalog/catalog.test.tsx`: 40건 통과(정확 일치 선택·미등록·중복·기존 검색 저장 포함). 상품 이미지는 사진 업로드 크기·썸네일·휴지통·보존 기간이 정해지지 않아 보류한다([D-13](../pending-decisions-2026-10-14.md#d-13-사진-저장소)).

## 후속 정정 — 상품 이미지 정책 분리

위 문장의 이미지 보류는 당시 메모이며, 2026-10-20에 상품 이미지에 한해 기존 private 파일 저장소 재사용·JPEG/PNG/WebP·5 MiB·연결 해제 방식으로 정책을 정하고 별도 구현했다. 현재 범위와 상태는 [상품 이미지 감사 기록](2026-10-20-catalog-product-images.md)을 따른다. 고객 시술 사진의 보관·영구 삭제는 여전히 D-10 결정 대기다.
