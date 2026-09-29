# 개발용 Python 실행 차단 검토 요청

확인일: 2026-09-22
프로젝트: D:\ms\business-assistant
증상: 서버 시작 시 import ssl → _ssl 로드에서 애플리케이션 제어 정책 차단.

## 확인된 증거

- CodeIntegrity/Operational 이벤트 3077, 3033에서 Python DLL 차단 확인.
- 정책 ID: {0283ac0f-fff1-49ae-ada1-8a933130cad6}
- 런타임: C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.13.15-windows-x86_64-none
- 차단 파일: DLLs\libssl-3-x64.dll, DLLs\_queue.pyd
- 두 파일 Authenticode 상태: NotSigned.
- 런타임 실행 파일과 차단 DLL의 생성/수정 시각은 2026-09-15. 가상환경 pyvenv.cfg도 2026-09-15 이후 수정 흔적 없음.
- 가상환경은 cpython-3.13-windows-x86_64-none junction을 통해 위 3.13.15 경로를 참조. junction도 2026-09-15 생성/수정.
- 9월18일 동일 프로젝트 테스트 실행은 성공했으나, 당시 DLL 해시나 정책 상태를 보관하지 않아 정책 변경 시점/세부 원인은 확정하지 못함.
- 프로젝트 Python 요구 범위는 >=3.13,<3.14. 설치된 별도 Python3.14는 현재 프로젝트의 지원 범위 밖.

## 요청

해당 개발 도구 배포본의 출처/신뢰 및 차단 원인을 검토하고, 회사 정책에 적합한 Python3.13 런타임을 제공하거나 승인된 절차로 실행 가능하도록 조치 요청.
전역 보안 기능 해제나 임의 파일 차단 우회는 수행하지 않음.

## 조치 후 확인

프로젝트 가상환경을 승인된 런타임에 연결한 뒤 SSL import, 서버 시작, 로컬 health 확인 순으로 검증.
DB migration016 적용 여부는 이 실행 차단과 별도의 항목.
