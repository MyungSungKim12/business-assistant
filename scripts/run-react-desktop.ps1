# 하위 호환: 기존 이름으로 실행해도 API 서버까지 함께 띄우는 run-app.ps1을 호출한다.
& (Join-Path $PSScriptRoot 'run-app.ps1') @args
