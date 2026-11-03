# DOC-012 고객 모바일 문서 서명 링크 — 2026-11-03

## 범위

- 시술별 불변 발행 문서에 owner/admin이 고객 서명 링크를 생성·철회한다.
- API 공개 origin은 `APP_PUBLIC_DOCUMENT_SIGNING_ORIGIN`으로 고정한다. 운영은 HTTPS만 허용하며 설정이 없으면 링크 생성이 차단된다.
- URL fragment에 전달된 256-bit 무작위 원문 토큰은 브라우저에서 즉시 주소창 이력에서 제거한다. 서버/DB에는 SHA-256 토큰만 전송·보관한다. URL query/path, Fastify request log, 외부 provider에는 토큰을 넣지 않는다.
- 링크는 48시간 후 만료한다. 발행본별 교체 시 이전 미사용 링크를 철회하고 행위자/사유를 저장한다. 링크 테이블은 RLS enabled, anon/authenticated 직접 접근은 없다.
- 공개 화면은 제목·발행 본문·서식 버전·만료 시각만 제공한다. 저장된 고객 프로필·전화번호·조직/시술 식별자는 내보내지 않는다.
- 제출은 DB의 링크/발행본 행 잠금 안에서 검사·서명 이벤트·증빙 hash·소비 시각을 단일 트랜잭션으로 기록한다. 서명 이벤트의 actor_id는 null이며 signer_channel=`customer_link`로 구분하고 기존 직원 기록을 잘못 귀속하지 않는다. 동일 요청 ID·동일 서명 재시도만 성공한다.

## 파일 및 DB

- `migrations/111_customer_document_signing_links.sql`: hash-only link table, signer channel, public preview/sign RPC, DB-side evidence and verify RPC.
- `migrations/112_customer_signature_link_audit.sql`: 직원 철회자/교체 사유 보존, 동시 발급 직렬화 및 고객/시술/발행본 scope 검사.
- `apps/api/src/modules/documents/public-signatures.ts`: nonce CSP가 있는 mobile page, 최소 DTO, public PostgREST RPC, 요청 제한.
- `apps/api/src/modules/documents/routes.ts`, `gateway.ts`: 직원 링크 생성/철회와 기존 role/feature 검사.
- `apps/desktop-react/src/features/documents/TreatmentDocumentModal.tsx`: 발행 이력에서 고객 링크 생성·복사·철회.

## 검증 증거

- `node scripts/db-tests/customer-document-signatures-111.mjs`: PGlite 통과. hash-only, 최소 미리보기, role boundary, 만료/소비/철회, 동일 요청 재시도, 새 링크 교체 actor/reason, evidence hash 검증 및 타 서명/재사용 차단.
- `pnpm --dir apps/api exec vitest run src/modules/documents/public-signatures.test.ts src/modules/documents/documents.test.ts src/modules/documents/consent.test.ts src/config.test.ts`: 4 files / 134 tests 통과.
- `pnpm api:build`: 통과.
- `pnpm --dir apps/desktop-react exec vitest run src/features/documents`: 10 files / 119 tests 통과.
- `pnpm react:build`: 통과. 기존 큰 chunk 경고가 있다.
- SQL111 원격 version `20261103005458`, SQL112 version `20261103005609` 적용. Postflight: 고객 19, 시술 14, 발행 문서 3, 서명 링크 0. RLS=true, direct table grants=0, `actor_id` nullable, anon public RPC=2, authenticated staff RPC=3.

## 제한 및 후속 인수

- 운영 서버/고정 도메인/리버스 프록시가 구성되지 않아 `APP_PUBLIC_DOCUMENT_SIGNING_ORIGIN`은 미설정 상태다. 로컬 개발에서는 실제 휴대폰의 접속 가능한 HTTPS 주소를 배포 계층에서 제공해야 하며, HTTP 공개 링크는 production에서 차단한다.
- 실제 Android/iOS 브라우저 인수, 실제 운영 동의문 검토, 법적 효력·고객 본인 확인은 수행하지 않았다. 서명은 공인 전자서명이나 본인인증을 대체하지 않는다.
- 링크 생성 응답이 유실되면 DB에는 hash만 있어 원문 URL을 다시 조회할 수 없다. 직원은 기존 링크를 새로 생성해 교체해야 한다.
