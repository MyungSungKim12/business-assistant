# Project Guide Site Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-07-project-guide-site-design.md`

## Global constraints

- 기존 제품 계획과 현재 작업 중인 애플리케이션 소스를 변경하지 않는다.
- 화면과 버튼 명칭은 현재 코드와 일치시킨다.
- 기능 상태는 `docs/product`를 단일 출처로 삼는다.
- 비밀값이나 실제 고객 데이터를 문서에 포함하지 않는다.
- 원격 push와 GitHub Pages 실제 게시를 수행하지 않는다.

## Task 1: 문서 품질 검증기

**Files:** `scripts/docs/validate-guide.ps1`

1. 새 문서 구조가 없어서 실패하는 검증을 먼저 실행한다.
2. 필수 문서, 내비게이션, 이미지와 금지된 비밀값 패턴을 검사하는 스크립트를 작성한다.
3. 검증기가 새 가이드 전체를 검사할 수 있는 상태로 만든다.

## Task 2: 사이트 구성과 디자인

**Files:** `mkdocs.yml`, `requirements-docs.txt`, `docs/guide/assets/stylesheets/extra.css`, `docs/guide/assets/javascripts/extra.js`

1. 사이트 구성 필수 항목 검증을 실패시킨다.
2. 한국어 검색, 탐색, Mermaid, 이미지 확대와 밝은 베이지 디자인을 설정한다.
3. 엄격 빌드에서 허용되는 링크 구조를 사용한다.

## Task 3: 독자별 가이드 작성

**Files:** `docs/guide/**/*.md`

1. 필수 페이지 검증을 실패시킨다.
2. 시작하기, 화면별 사용법, 업무 흐름, 운영, 개발, 문제 해결 문서를 작성한다.
3. 현재 구현과 준비 중 기능을 구분하고 기존 제품 문서로 연결한다.

## Task 4: GitHub Pages 자동 배포

**Files:** `.github/workflows/docs-pages.yml`, `README.md`

1. 배포 설정 검증을 실패시킨다.
2. pull request 빌드와 main Pages 배포를 구성한다.
3. README에서 로컬 문서 실행과 가이드 진입점을 제공한다.

## Task 5: 전체 검증과 검토

1. 문서 자체 검증을 통과시킨다.
2. MkDocs 엄격 빌드를 수행한다.
3. 생성된 사이트의 주요 페이지와 화면 이미지를 확인한다.
4. 변경 범위를 검토하고 남은 제한을 기록한다.
