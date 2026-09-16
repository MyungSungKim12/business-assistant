# 메뉴와 모듈

기능 권한의 기준은 메뉴 번호가 아니라 문자열 기능 코드입니다. 따라서 같은 메뉴 구조를 유지하면서 상품이나 업종별 기능을 유연하게 바꿀 수 있습니다.

| 번호 | 메뉴 | 기능 코드 | 초기 상태 |
| --- | --- | --- | --- |
| 1 | 홈 대시보드 | 없음 | 사용 가능 |
| 2 | 고객·거래처 | `crm.basic` | 고객 CRUD 사용 가능 |
| 3 | 일정·할 일 | `schedule.basic` | 준비 중 |
| 4 | 문서 자동화 | `document.template` | 준비 중 |
| 5 | 매출·지출 | `finance.basic` | 준비 중 |
| 6 | 파일·자료 | `files.basic` | 준비 중 |
| 7 | 데이터 가져오기·내보내기 | `data.basic` | 준비 중 |
| 8 | 보고서·분석 | `reports.basic` | 준비 중 |
| 9 | 업무 자동화 | `automation.custom` | 준비 중 |
| 10 | AI 업무 도우미 | `ai.summary` | 준비 중 |
| 11 | 알림센터 | `notifications.basic` | 준비 중 |
| 12 | 팀·직원 | `team.basic` | 준비 중 |
| 13 | 외부 서비스 연동 | `integrations.basic` | 준비 중 |
| 14 | 계정·구독 | 없음 | 사용 가능 |
| 15 | 환경설정 | 없음 | 사용 가능 |

초기 데스크톱 셸은 기능 코드가 없는 홈 대시보드, 계정·구독, 환경설정만 항상 보입니다. 나머지는 서버가 허용한 코드가 있을 때 보입니다. 고객·거래처 API는 `crm.basic` 권한과 조직 멤버십을 검사하며, 변경 작업은 owner 또는 admin 역할만 허용합니다. 다음 구현 순서는 일정·할 일, 문서 자동화입니다.

업종별 기능은 공통 코드를 바꾸지 않고 별도 네임스페이스로 추가합니다. 예를 들어 학원은 `academy.student`와 `academy.attendance`, 미용실은 `salon.reservation`과 `salon.stylist`, 부동산은 `realestate.listing`과 `realestate.contract`를 사용할 수 있습니다.
