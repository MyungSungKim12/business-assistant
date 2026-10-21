# INV-11 상품 이미지 연결

## 범위와 상태

2026-10-20 기준 소스 구현 및 집중 검증을 마쳤다. SQL 080은 Supabase 적용 대기이며 실제 Storage 왕복과 설치 앱 화면은 확인하지 않았다. 이 기능만으로 INV-11 전체를 완료로 표시하지 않는다.

상품은 기존 private `business-files` 파일 라이브러리의 파일을 선택해 이미지로 연결한다. 업로드 형식은 JPEG, PNG, WebP이고 최대 크기는 5 MiB다. 브라우저에서 미리보기하고, 저장된 비공개 파일은 기존 파일 API로 서명 미리보기 URL을 받아 표시한다. 이미지 제거는 상품과의 연결만 해제한다.

## 데이터·권한

- `catalog_products.image_file_id`는 `file_assets`를 참조한다.
- DB 트리거가 조직 일치, 미보관 상태, 허용 MIME, 5 MiB를 재검증한다.
- 이미지 연결 변경은 owner/admin 전용 버전·멱등 RPC를 사용한다.
- 연결된 파일의 보관 처리는 DB가 거절한다. 먼저 상품에서 연결을 해제해야 한다.
- 새 버킷, 공개 링크, 썸네일 생성, 원본 파일 삭제는 포함하지 않는다.
- 파일 업로드 후 상품 연결이 실패하면 파일은 라이브러리에 남을 수 있다. 사용자는 파일 메뉴에서 확인·정리할 수 있다.

## 집중 검증

- `npm run test:catalog-product-images --prefix scripts/db-tests`: PGlite에서 조직/MIME/크기/권한, 멱등 재시도, 버전 충돌, 연결 중 보관 차단, 연결 해제 후 보관 성공 통과.
- `pnpm --filter @business-assistant/api test -- catalog.test.ts`: 52개 통과.
- `pnpm --filter @business-assistant/api build`: 통과.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/catalog/catalog.test.tsx`: 35개 통과.
- `pnpm --filter @business-assistant/desktop-react build`: 통과. 대형 번들 경고가 있으나 빌드 실패는 아니다.

## 적용과 남은 범위

사용자가 065까지 적용했다고 보고했으므로 **066~081**을 번호 순서로 적용해야 한다. 080은 079 이후다. 적용 후 API와 앱을 재시작하고 owner/admin 계정으로 이미지 업로드·교체·제거, member의 쓰기 거부, 파일 보관 거부를 확인한다. 이 기록은 실환경 인수를 뜻하지 않는다.

상품 이미지 정책은 D-13의 상품 이미지 범위만 해결한다. 고객 시술 사진의 휴지통·영구 파기와 보관 기간은 D-10/CRM-15에서 별도로 결정해야 한다. 구매 단위 환산도 INV-11 잔여다.
