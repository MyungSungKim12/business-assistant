# Node/TypeScript API 전환 설계

상태: 사용자 설계 승인 · 구현 계획 작성 전  
기준일: 2026-10-13  
추적 ID: API-001

## 목표

Python FastAPI 서버를 Node.js TypeScript API 서버로 단계적으로 대체해 React/Tauri와 서버를 하나의 언어 생태계로 통일한다. 완성 후에는 Python 런타임, uv 가상환경, FastAPI 코드와 PySide6 코드를 제거한다.

회사의 애플리케이션 제어 정책이 프로젝트 `.venv\\Scripts\\python.exe`를 차단하는 현상은 이 전환의 직접적인 동기다. 정책을 우회하거나 비밀키를 React/Tauri 앱에 넣지 않는다.

## 결정

- HTTP 서버는 Node.js 24와 TypeScript, Fastify를 사용한다.
- API 기본 주소와 경로는 기존과 같이 `http://127.0.0.1:8000/api/v1`로 유지한다.
- Supabase 서비스 키, 조직·역할 검증, 파일 서명 URL 발급은 Node 서버 안에만 둔다.
- 요청·응답은 Zod 런타임 검증 스키마를 `packages/api-contract`에 정의해 React와 서버가 공유한다.
- Python 서버는 기능별 동등성 검증이 끝날 때까지 읽기 전용 기준 구현으로 남기며, 새 Node 서버가 해당 API를 대체한 뒤 제거한다.
- SQL 마이그레이션과 Supabase 스키마는 그대로 유지한다. 데이터 이전은 하지 않는다.

## 기준 코드와 작업공간

현재 React/Tauri 구현은 `codex/react-tauri-customer` 브랜치의 `apps/desktop-react`, `packages/react-ui`, 루트 pnpm 구성에 있다. Node 전환 시작 전 이 기반을 현재 작업 브랜치에 반영한다. 같은 파일을 수동으로 복사해 두 개의 기준 구현을 만들지 않는다.

```text
React/Tauri Desktop
       │ HTTPS / localhost HTTP
       ▼
Fastify TypeScript API (apps/api)
       │
       ▼
Supabase Auth / PostgreSQL / Storage
```

## API 경계

### 공통 동작

- 인증 헤더는 `Authorization: Bearer <access token>`을 사용한다.
- 인증 실패는 401, 다른 조직·권한·구독 기능 접근은 403, 존재하지 않는 리소스는 404로 유지한다.
- 유효성 오류는 422와 필드별 오류를 반환한다.
- 쓰기 요청은 기존의 작업 ID와 버전 충돌 계약을 보존한다.
- 파일 업로드·다운로드는 Supabase Storage의 제한된 signed URL만 응답한다.
- 서버는 조직 ID를 신뢰하지 않고 토큰의 멤버십·역할·기능 권한과 다시 대조한다.

### 이전 순서

1. **기반 API**: `/health`, 로그인·갱신·내 정보, 조직 목록, entitlement.
2. **현재 React 수직 기능**: 고객 목록·등록·수정·보관, 고객 활동, 사진 목록·서명 URL·삭제, 대시보드 고객·할 일.
3. **운영 핵심**: 예약·담당자·공간·장비, 상담·시술, 문서·동의, 결제·매출·회원권.
4. **ERP 확장**: 상품·재고·구매, 직원·수당, 비용·정산·손익, 파일·관리 기능.
5. Python FastAPI 및 uv 환경 제거.

각 단계는 이전 API와 동일한 HTTP 계약 테스트, 권한·조직 격리·실패·재시도 검증을 마친 뒤 다음 단계로 진행한다. 아직 이전하지 않은 엔드포인트는 Python 서버를 통해서만 제공하며, Node 서버에서 빈 응답이나 임시 성공으로 흉내 내지 않는다.

## 저장소 구조

```text
apps/
  api/                         # Fastify TypeScript 서버
    src/
      app.ts                   # Fastify 조립과 공통 오류 변환
      config.ts                # 서버 전용 환경 변수 검증
      plugins/auth.ts          # Supabase 토큰·조직·권한 검사
      routes/                  # API 도메인별 Fastify 라우트
      services/                # Supabase 질의와 업무 규칙
  desktop-react/               # React/Tauri 클라이언트
packages/
  api-contract/                # Zod 요청·응답/오류 계약
  react-ui/                    # 디자인 시스템
```

`apps/server`, `packages/common`, 루트 `pyproject.toml`, `uv.lock`은 최종 제거 단계 전까지 기존 Python 기준 구현으로만 남긴다. Node API 코드와 Python API 코드를 섞지 않는다.

## LCID에서 이식할 운영 기능

LCID는 CID·통관 제품이므로 코드를 복사하지 않는다. 각 기능은 React/Tauri와 Fastify 구조에 맞게 새로 구현하며, 원본의 라이선스·출처는 별도 추적한다.

| LCID 기능 | Business Assistant 적용 | 이전 단계 |
| --- | --- | --- |
| 상단 메뉴, 연결 상태, 팝업·알림 호스트, DataGrid | 전체 앱의 공통 UX | React 기반 반영 |
| 검색 조건 저장, 최근 조회, 즐겨찾기 | 고객·예약·문서·재고의 빠른 접근 | 고객 API 이후 |
| 고객 태그, 태그 편집, 상담 메모 템플릿 | 고객 분류·상담·시술 기록 | CRM/TRT 단계 |
| 담당자 후속 업무, 기한, 완료 처리 | 고객 이슈·사후관리 | CARE 단계 |
| 부재중 이벤트 및 재연락 목록 | 예약 누락·노쇼·미응답 고객 후속 처리 | APT/CARE 단계 |
| 대시보드 지표와 원본 목록 이동 | 예약·매출·미수·재고 알림 드릴다운 | DASH/FIN 단계 |
| 근태 위젯, 휴가·정정·승인 흐름 | 직원 근무·휴무·수당 근거 | TEAM 단계 |
| 공지·시작 알림·읽음 처리 | 매장 공지, 정책·업데이트 안내 | NOTI 단계 |
| 파일 첨부·다운로드, 엑셀 가져오기·내보내기 | 고객·상품·재고·정산 자료 | DOC/INV 단계 |
| SSE 연결, 지수 재연결, 연결 상태 | 예약 변동·알림·재고 경고 실시간 반영 | 이벤트 계약 이후 |
| 앱 업데이트 확인·자동 실행·환경 설정 | Tauri 배포 운영 | 패키징 단계 |
| 관리자 운영 화면, 장치·사용자·감사 조회 | 다지점·권한·운영 지원 | 설정·관리 단계 |
| 광고 슬롯, 노출 수 집계, 관리자 관리 화면 | 수신 동의 고객 대상 캠페인·배너, 예약·재방문 전환 성과 | MKT 단계 |

통화 제어·녹취, LG U+ 연동, 통관 DB는 뷰티 매장 운영 데이터와 직접 연결되지 않으므로 이 프로젝트에 이식하지 않는다. 광고는 단순 외부 배너가 아니라 고객 동의·발송 시간·수신 거부·캠페인·성과와 연결된 매장 마케팅 기능으로 이식한다. LCID의 기능이 우리 제품에 새 데이터·권한·알림 규칙을 요구하면 해당 메뉴 기능 ID와 Supabase 마이그레이션을 먼저 추가한다.

## 보안과 운영

- `SUPABASE_SERVICE_KEY`는 `apps/api` 프로세스 환경 변수에만 둔다.
- React의 `VITE_*` 변수에는 API 기본 URL처럼 공개 가능한 값만 둔다.
- 개발 서버는 localhost에만 바인딩하며, 배포 환경은 HTTPS 종료 지점 뒤에서 실행한다.
- CORS는 개발 React 원점과 Tauri 앱의 필요한 원점으로 제한한다.
- 업로드 경로는 서버가 생성하고 파일명은 정규화한다.
- 구조화 로그에는 access token, 서비스 키, 고객 의료·시술 메모 본문을 기록하지 않는다.

## 실행과 검증

- `scripts/run-server.ps1`은 Node API를 실행하도록 전환한다.
- `scripts/bootstrap.ps1`은 pnpm 의존성과 Node 24를 확인한다.
- `pnpm api:test`는 Fastify route injection과 모의 Supabase 어댑터로 API 계약을 검사한다.
- `pnpm react:test -- --run`은 UI/API 클라이언트 동작을 검사한다.
- `pnpm react:build`와 `pnpm api:build`는 TypeScript 빌드를 검사한다.
- Windows에서 Node 프로세스 실행, 로그인, 고객 조회·등록·사진 등록을 실제 Supabase 연결로 확인한다.

## 완료 기준

Python을 제거하는 시점에는 다음을 모두 충족해야 한다.

1. 기존 FastAPI 라우트 전체가 Node 서버에 계약 동등성으로 구현되어 있다.
2. 모든 쓰기 흐름에 권한·다른 조직 차단·취소·중복 재시도 검증이 있다.
3. React/Tauri가 Node 서버만으로 로그인부터 고객·예약·시술·결제·문서·ERP 업무를 수행한다.
4. Node 서버의 Windows 실행과 Tauri 설치 앱 인수가 완료되어 있다.
5. Python 의존성 제거 후에도 Node·React 검사와 실환경 핵심 흐름이 통과한다.

## 제외 범위

- Supabase 데이터베이스·RLS 정책의 재설계
- 현재 기능 범위를 넘는 신규 업무 메뉴
- 회사 보안 정책의 변경 또는 우회
- 이전이 끝나기 전 Python 서버의 성급한 삭제
