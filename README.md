# Business Assistant

업종에 관계없이 사용할 수 있는 **구독형 Python 데스크톱 업무 관리 프로그램**입니다. 공통 업무 기능을 먼저 제공하고, 이후 학원·미용실·부동산 등 업종별 기능을 모듈 형태로 확장합니다.

> 현재 상태: 설계 단계 — Python 프로젝트 초기 설정 전

## 프로젝트 목표

- Windows에서 실행되는 설치형 업무 프로그램 제공
- 고객, 일정, 문서, 매출, 데이터 등 공통 업무를 한곳에서 관리
- 구독 상품에 따라 메뉴와 기능을 자동으로 활성화
- 사용자, 조직, 직원 역할과 등록 기기를 서버에서 관리
- 공통 기능을 유지하면서 업종별 모듈을 독립적으로 추가
- Supabase에 종속되지 않도록 서비스 경계를 분리

## 핵심 원칙

1. 데스크톱 앱은 데이터베이스에 직접 연결하지 않습니다.
2. 모든 보호된 작업은 FastAPI 서버를 거칩니다.
3. 메뉴를 숨기는 것만으로 권한을 처리하지 않습니다.
4. 서버가 구독 상태와 기능 권한을 매 요청마다 검증합니다.
5. 관리자 키와 DB 비밀번호는 데스크톱 앱에 포함하지 않습니다.
6. 외부 서비스는 어댑터로 분리해 향후 교체할 수 있게 합니다.

## 시스템 구조

```text
PySide6 Desktop
  ├─ 로그인과 세션
  ├─ 메뉴와 업무 화면
  └─ 로컬 파일·Excel·PDF 처리
          │ HTTPS + access token
          ▼
FastAPI Server
  ├─ 사용자 인증
  ├─ 조직·직원 역할 확인
  ├─ 구독·기능 권한 확인
  ├─ 업무 서비스
  └─ 감사 로그
          │
          ▼
Supabase
  ├─ Auth
  ├─ PostgreSQL
  └─ Storage
```

## 기술 스택

| 영역 | 기술 |
|---|---|
| 언어 | Python 3.13 |
| 패키지·가상환경 | uv |
| 데스크톱 UI | PySide6 |
| API 서버 | FastAPI + Uvicorn |
| 데이터 계층 | SQLAlchemy 2.x + Alembic |
| 운영 데이터베이스 | Supabase PostgreSQL |
| 인증 | Supabase Auth |
| 파일 저장 | Supabase Storage |
| 설정 | Pydantic Settings |
| 테스트 | pytest |
| 코드 품질 | Ruff + mypy |
| 소스 관리 | Git + GitHub |

## 범용 메뉴

1. 홈 대시보드
2. 고객·거래처 관리
3. 일정·할 일 관리
4. 문서 자동화
5. 매출·지출 관리
6. 파일·자료 관리
7. 데이터 가져오기·내보내기
8. 보고서·분석
9. 업무 자동화
10. AI 업무 도우미
11. 알림센터
12. 팀·직원 관리
13. 외부 서비스 연동
14. 계정·구독
15. 환경설정

초기 실행 버전에서는 홈 대시보드, 계정·구독, 환경설정을 먼저 활성화합니다. 업무 모듈은 고객·거래처, 일정·할 일, 문서 자동화 순서로 구현합니다.

## 구독과 기능 권한

구독은 메뉴 번호가 아니라 문자열 형태의 기능 코드로 관리합니다.

```text
dashboard.basic
crm.basic
document.template
automation.custom
ai.summary
```

예시 상품 구성:

```text
BASIC
├─ dashboard.basic
├─ crm.basic
└─ task.personal

STANDARD
├─ BASIC의 모든 기능
├─ document.basic
├─ data.import
└─ finance.basic

PRO
├─ STANDARD의 모든 기능
├─ report.custom
├─ automation.basic
└─ ai.summary
```

데스크톱 앱은 로그인 후 허용된 기능 목록을 받아 메뉴를 구성합니다. 실제 API 역시 동일한 기능 코드를 검사하므로 화면 조작만으로 유료 기능을 사용할 수 없습니다.

## 핵심 데이터 모델

- `profiles`: 사용자 프로필
- `organizations`: 회사 또는 사업장
- `memberships`: 사용자와 조직의 관계 및 역할
- `plans`: 판매되는 구독 상품
- `features`: 개별 기능 코드
- `plan_features`: 상품에 포함된 기능
- `subscriptions`: 조직의 구독 상태와 기간
- `device_registrations`: 허용된 PC 등록
- `audit_logs`: 보안·관리 작업 기록

모든 업무 데이터는 `organization_id`를 기준으로 분리합니다. PostgreSQL의 RLS와 서버 권한 검사를 함께 적용해 다른 조직의 데이터가 노출되지 않도록 설계합니다.

## 저장소 구조

```text
business-assistant/
├─ apps/
│  ├─ desktop/                 # PySide6 데스크톱 앱
│  └─ server/                  # FastAPI 백엔드
├─ packages/
│  └─ common/                  # 공통 타입과 API 계약
├─ docs/                       # 제품·설계·개발 문서
├─ migrations/                 # 데이터베이스 마이그레이션
├─ scripts/                    # 개발 편의 스크립트
├─ tests/                      # 저장소 수준 테스트
├─ .env.example
├─ .gitignore
├─ .python-version
├─ pyproject.toml
├─ uv.lock
└─ README.md
```

## 구현 로드맵

### 1단계 — 프로젝트 기반

- [ ] uv와 Python 3.13 개발환경
- [ ] 모노레포 및 공통 설정
- [ ] PySide6 최소 실행 화면
- [ ] FastAPI 상태 확인 API
- [ ] 테스트, 린트, 타입 검사
- [ ] 개발 및 Git 문서

### 2단계 — 사용자와 조직

- [ ] Supabase Auth 연결
- [ ] 회원가입, 로그인, 세션 갱신
- [ ] 사용자 프로필
- [ ] 조직과 직원 역할

### 3단계 — 구독과 권한

- [ ] 상품 및 기능 데이터 모델
- [ ] 구독 상태 관리
- [ ] 기능 권한 계산 API
- [ ] 권한에 따른 메뉴 활성화
- [ ] 등록 기기 제한

### 4단계 — 범용 업무 기능

- [ ] 고객·거래처
- [ ] 일정·할 일
- [ ] 문서 자동화
- [ ] 매출·지출
- [ ] 보고서·분석

### 5단계 — 상용화

- [ ] 결제대행사 및 웹훅
- [ ] Windows 설치 파일
- [ ] 자동 업데이트
- [ ] 운영 배포, 백업, 모니터링

## 보안

- Supabase 관리자 키와 DB 비밀번호는 서버 환경변수로만 관리합니다.
- Git에는 `.env`와 비밀정보를 커밋하지 않습니다.
- FastAPI는 토큰 서명, 발급자, 대상, 만료를 검증합니다.
- 모든 업무 요청에서 사용자, 조직, 역할, 구독 권한을 검사합니다.
- 테넌트 데이터에는 RLS를 적용하고 관련 열을 인덱싱합니다.
- 로그인, 구독, 기기, 권한 변경은 감사 로그에 기록합니다.
- 로그에는 비밀번호, 토큰, 키, 민감한 고객 정보를 남기지 않습니다.

## 개발 상태

현재는 제품과 기술 설계가 완료되어 검토 중입니다. 설계 승인 후 실행 가능한 데스크톱·서버 골격과 개발 문서를 추가합니다. Supabase 자격 증명이 없어도 기본 프로그램과 테스트를 실행할 수 있게 구성할 예정입니다.

## 문서

- [상세 설계서](docs/superpowers/specs/2026-09-14-business-assistant-design.md)

## 라이선스

라이선스는 제품 공개 및 배포 방침이 결정된 후 선택합니다. 결정 전까지 모든 권리를 저장소 소유자가 보유합니다.
