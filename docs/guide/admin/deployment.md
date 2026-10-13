# 서버 배포·운영 (HTTPS 프록시, 프로세스, 로그, 장애 대응)

이 문서는 Node API 서버를 원격 서버(예: 클라우드 VM)에 올려 데스크톱 앱이 HTTPS로 접속하게 하는 방법을 설명합니다. 개발 PC에서는 `scripts\run-server.ps1`만으로 충분하며 이 문서의 설정은 필요 없습니다.

## 구조

```text
데스크톱 앱 ──HTTPS 443──▶ 리버스 프록시(nginx 또는 Caddy)
                              ├─▶ 127.0.0.1:8000  일반 API   (사용자 토큰만 사용, 서비스 키 없음)
                              └─ (공개하지 않음)
관리자 API (127.0.0.1:8001) ◀── SSH 터널 또는 내부망에서만 접근 (서비스 키 사용)
```

- 일반 API와 관리자 API는 **서로 다른 프로세스**입니다. 서비스 키(`APP_SUPABASE_SERVICE_KEY`)는 관리자 프로세스만 읽습니다. 일반 API는 환경에 서비스 키가 있어도 시작 로그에 경고를 남기고 무시하며, 프로세스 환경에서 지웁니다.
- 데스크톱 앱은 Tauri(Rust)가 서버를 호출하므로 브라우저 CORS 설정은 필요하지 않습니다. 서버에 CORS 헤더를 추가하지 마세요.
- 앱은 `BUSINESS_ASSISTANT_API_BASE`가 HTTPS가 아니면(개발 빌드의 로컬 주소 제외) 접속을 거부합니다.

## 환경 변수

값을 비워 두거나 설정하지 않으면 기본값을 씁니다. 바인딩·포트·본문 크기 기본값은 이전 동작과 같고, 시도 제한은 새로 추가된 보호입니다.

| 변수 | 기본값 | 대상 | 설명 |
| --- | --- | --- | --- |
| `APP_SUPABASE_URL` | (필수) | 둘 다 | Supabase 프로젝트 주소 |
| `APP_SUPABASE_PUBLISHABLE_KEY` | (필수) | 둘 다 | publishable(anon) 키. 사용자 토큰과 함께 쓴다 |
| `APP_FILE_BUCKET` | `business-files` | 일반 | 파일 보관 버킷 이름 |
| `APP_API_HOST` | `127.0.0.1` | 일반 | 바인딩 주소. `0.0.0.0`이면 시작 시 경고 로그 |
| `APP_API_PORT` | `8000` | 일반 | 포트 |
| `APP_TRUST_PROXY` | `false` | 둘 다 | `false`, `true`, 홉 수(`1`), 또는 프록시 IP/CIDR 쉼표 목록(`127.0.0.1`). 프록시 뒤에서는 **프록시 IP 목록**을 권장 |
| `APP_BODY_LIMIT_BYTES` | `1048576` | 둘 다 | 요청 본문 최대 크기. 초과 시 413 |
| `APP_LOG_LEVEL` | `info` | 둘 다 | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `APP_AUTH_RATE_LIMIT_ENABLED` | `true` | 일반 | 로그인·회원가입·갱신 시도 제한 사용 여부 |
| `APP_ACCESS_CACHE_TTL_SEC` | `30` | 일반 | 권한(멤버십·구독) 검사 결과 메모리 캐시 시간(초). `0`이면 끈다. 구성원 변경 시 즉시 비우지만 서버를 여러 대로 늘리면 다른 서버는 이 시간까지 기다린다 |
| `APP_AUTH_LOGIN_MAX` / `APP_AUTH_LOGIN_WINDOW_SEC` | `10` / `600` | 일반 | 같은 IP(또는 IP+이메일)의 로그인 **실패** 허용 횟수 / 기간(초) |
| `APP_AUTH_LOGIN_EMAIL_MAX` | `30` | 일반 | 같은 이메일의 로그인 실패 합계(모든 IP 합산, 같은 기간) |
| `APP_AUTH_SIGNUP_MAX` / `APP_AUTH_SIGNUP_WINDOW_SEC` | `5` / `3600` | 일반 | 같은 IP·같은 이메일의 회원가입 시도 횟수 / 기간 |
| `APP_AUTH_REFRESH_MAX` / `APP_AUTH_REFRESH_WINDOW_SEC` | `60` / `600` | 일반 | 같은 IP의 토큰 갱신 횟수 / 기간 |
| `APP_AUTH_FAILURE_MIN_MS` | `250` | 일반 | 로그인 실패 응답의 최소 지연(밀리초) |
| `APP_SUPABASE_SERVICE_KEY` | (관리자만 필수) | 관리자 | 서비스 키. **일반 API 환경에는 두지 않는다** |
| `APP_PLATFORM_ADMIN_USER_IDS` | 빈 값(모두 거부) | 관리자 | 플랫폼 관리자 사용자 UUID 쉼표 목록 |
| `APP_ADMIN_HOST` | `127.0.0.1` | 관리자 | 관리자 서버 바인딩 주소 |
| `APP_ADMIN_PORT` | `8001` | 관리자 | 관리자 서버 포트(일반 API와 같으면 시작 거부) |
| `NODE_ENV` | (없음) | 둘 다 | `production`이면 개발용 자동 로그인 설정(`BUSINESS_ASSISTANT_DEV_AUTO_LOGIN`)이 있을 때 **시작을 거부**한다 |

운영 환경 파일에는 `BUSINESS_ASSISTANT_DEV_*` 값을 두지 마세요. 서버는 이 값을 사용하지 않지만, 두면 경고하고 프로세스 환경에서 지웁니다.

## 빌드와 실행

```bash
pnpm install --frozen-lockfile
pnpm --filter @business-assistant/api build          # apps/api/dist 생성
NODE_ENV=production node apps/api/dist/server.js          # 일반 API
NODE_ENV=production node apps/api/dist/admin-server.js    # 관리자 API (필요할 때만)
```

개발 PC에서는 `scripts\run-server.ps1`(일반 API)과 `scripts\run-admin.ps1`(관리자 API)을 씁니다. 두 스크립트는 `.env`를 읽되 서비스 키는 관리자 스크립트에만, 개발용 계정 값은 어느 쪽에도 싣지 않습니다.

## HTTPS 리버스 프록시

서버는 평문 HTTP만 말합니다. 인증서와 HTTPS는 프록시가 맡습니다. 일반 API만 프록시에 연결하고, **관리자 API 경로(`/api/v1/admin/`)는 외부에 열지 마세요**(아래 예시처럼 막습니다).

### nginx 예시

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    client_max_body_size 1m;                      # APP_BODY_LIMIT_BYTES 와 맞춘다

    location /api/v1/admin/ { return 404; }       # 관리자 API 는 공개하지 않는다

    location /api/v1/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;   # 클라이언트가 보낸 값을 이어 붙이지 않고 덮어쓴다
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
server { listen 80; server_name api.example.com; return 301 https://$host$request_uri; }
```

같은 서버의 nginx를 신뢰하려면 서버 환경에 `APP_TRUST_PROXY=127.0.0.1`을 둡니다. 이렇게 해야 로그인 시도 제한이 프록시 IP가 아닌 실제 클라이언트 IP로 동작합니다. 프록시를 거치지 않는 서버에서 `APP_TRUST_PROXY`를 켜면 누구나 `X-Forwarded-For`를 바꿔 제한을 피할 수 있으니 켜지 마세요.

### Caddy 예시

```caddy
api.example.com {
    request_body {
        max_size 1MB
    }
    @admin path /api/v1/admin/*
    respond @admin 404
    reverse_proxy 127.0.0.1:8000
}
```

Caddy는 인증서를 자동으로 발급·갱신하고 `X-Forwarded-For`를 설정합니다. 같은 서버의 Caddy라면 `APP_TRUST_PROXY=127.0.0.1`을 둡니다.

## 방화벽

- 외부에 여는 포트: **443**(HTTPS)과 필요하면 80(HTTPS로 전환용), SSH(관리자 IP만).
- **8000, 8001은 외부에 열지 않습니다.** 서버가 `127.0.0.1`에만 바인딩되어 있으므로 기본값을 바꾸지 않으면 외부에서 닿지 않습니다.
- 클라우드 보안 그룹과 서버 방화벽(ufw 등) 양쪽에서 확인합니다.
- 관리자 API가 필요하면 SSH 터널(`ssh -L 8001:127.0.0.1:8001 사용자@서버`)로 접속합니다.

## 프로세스 관리

서버가 죽으면 자동으로 다시 시작되어야 합니다. 환경 파일은 소유자만 읽도록(`chmod 600`) 둡니다.

### Linux: systemd (권장)

`/etc/systemd/system/business-assistant-api.service`

```ini
[Unit]
Description=Business Assistant API
After=network-online.target
Wants=network-online.target

[Service]
User=assistant
WorkingDirectory=/srv/business-assistant
EnvironmentFile=/etc/business-assistant/api.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/api/dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now business-assistant-api
sudo systemctl status business-assistant-api
```

관리자 API가 필요하면 같은 형식으로 `business-assistant-admin.service`(`ExecStart=... admin-server.js`, `EnvironmentFile=/etc/business-assistant/admin.env`)를 따로 만들고 서비스 키는 `admin.env`에만 둡니다.

### 대안

- **pm2**: `pm2 start apps/api/dist/server.js --name ba-api` 후 `pm2 save`, `pm2 startup`. 환경 변수는 ecosystem 파일 대신 서비스 사용자 환경에 둡니다.
- **Windows 서버**: NSSM 등으로 `node.exe apps\api\dist\server.js`를 서비스로 등록하고 복구 동작을 "다시 시작"으로 지정합니다. 환경 변수는 서비스 설정(AppEnvironmentExtra)에 둡니다.

## 로그

- 서버는 JSON 한 줄 로그를 표준 출력에 남깁니다. systemd라면 `journalctl -u business-assistant-api -f`, pm2라면 `pm2 logs ba-api`, nginx 접근 로그는 `/var/log/nginx/`에서 봅니다.
- `Authorization`·쿠키·비밀번호·토큰 필드는 로그에서 `[REDACTED]`로 가려지고, 요청 URL의 `token`·`key`·`signature` 같은 쿼리 값도 가려집니다. 요청/응답 본문은 기록하지 않습니다.
- 5xx 오류에는 오류 종류만 남고 원문 메시지는 남기지 않습니다. 응답의 `requestId`로 해당 로그를 찾습니다.
- journald는 보관 기간이 제한되므로 필요하면 `SystemMaxUse`, `MaxRetentionSec`을 설정합니다.
- 감사 로그(민감 작업 기록)는 서버 로그가 아니라 DB의 `audit_events` 테이블에 있습니다(아래 참고).

## 헬스체크

| 주소 | 용도 | 응답 |
| --- | --- | --- |
| `GET /api/v1/health` | 프로세스 생존(프로세스 관리자·로드밸런서) | 항상 `200 {"status":"ok"}` |
| `GET /api/v1/health/ready` | 의존성 점검(Supabase Auth 도달 여부) | `200`/`503` `{"status","checks":{"supabase"}}`. 주소·키·오류 원문은 담지 않고 5초 캐시 |

관리자 서버에는 `GET /api/v1/health`만 있습니다. 모니터링 서비스는 `/health/ready`를 1분 간격 정도로 호출하세요.

## 시도 제한과 한계

- 로그인은 **실패만** 셉니다. 같은 IP 10회/10분, 같은 이메일(모든 IP 합산) 30회/10분을 넘으면 `429`와 `Retry-After` 헤더(초), 한국어/영어 안내 문구를 돌려줍니다. 성공하면 그 IP+이메일 키만 초기화하며, 다른 IP의 잠금과 이메일 단위 누적은 유지됩니다.
- 존재하지 않는 이메일과 틀린 비밀번호는 같은 `401` 응답이며, 실패 응답은 최소 250ms 뒤에 나갑니다.
- 카운터는 **프로세스 메모리**에만 있습니다. 서버를 재시작하면 초기화되고, **인스턴스를 여러 개 띄우면 인스턴스마다 따로 셉니다.** 다중 인스턴스(로드밸런서 뒤 2대 이상)로 확장하려면 Redis 같은 공유 저장소 기반 제한이나 프록시 계층(nginx `limit_req`, 클라우드 WAF)이 필요합니다. 단일 인스턴스 운영을 기본으로 가정합니다.
- 이메일 단위 한도는 공격자가 특정 계정을 일시 잠그는 데 악용될 수 있습니다. 필요하면 `APP_AUTH_LOGIN_EMAIL_MAX`를 올리세요.
- 키 수가 5만 개를 넘으면 오래된 키부터 버립니다(메모리 보호).

## 감사 로그(040 마이그레이션)

- SQL Editor에서 `migrations/040_audit_log.sql`을 **039 다음에, 서버를 새 버전으로 올리기 전에** 실행합니다.
- 기록 대상: 고객 영구 삭제, 환불, 상품 반품, 일 마감·마감 정정, 동의서 서명·교부·철회, 문서 발행, 서식 발행(publish), 파일 보관, 구독 교체.
- 고객 영구 삭제는 감사 기록이 먼저 성공해야 진행됩니다(기록이 안 되면 `503`). 나머지는 본 작업이 끝난 뒤 기록하며, 기록 실패는 서버 로그에 경고(`audit event was not recorded`)만 남깁니다. 이 경고가 반복되면 040 적용 여부와 Supabase 상태를 확인하세요.
- 조회: owner/admin이 `GET /api/v1/organizations/{조직 ID}/audit-events?from=&to=&action=&limit=&cursor=`로 봅니다(최신순, `next_cursor`로 다음 페이지).
- 한계: 일반 API는 사용자 토큰으로 기록하므로, 악의적인 조직 구성원이 DB 함수를 직접 호출해 자기 조직에 가짜 이벤트를 남길 수 있습니다(`source = 'api_user'`로 구분되며 actor는 항상 본인). 감사 로그는 "변조 불가"가 아니라 "삭제·수정 불가(append-only)"입니다.

## 장애 대응

| 증상 | 확인 | 조치 |
| --- | --- | --- |
| 앱이 "서버에 연결하지 못했습니다" | `curl https://api.example.com/api/v1/health` | 프록시·인증서 만료·방화벽 확인 → 프로세스 상태(`systemctl status`) → 재시작 |
| 헬스는 정상, `ready`가 503 | `journalctl`에서 5xx와 `Authentication unavailable` | Supabase 상태 페이지 확인, 프로젝트 일시 중지 여부, 서버에서 Supabase로 나가는 네트워크 확인 |
| 로그인이 계속 429 | 응답의 `Retry-After`, 프록시 뒤라면 `APP_TRUST_PROXY` | 프록시 IP를 신뢰하도록 설정하지 않으면 모든 사용자가 한 IP로 보여 함께 잠긴다. 설정 후 재시작(카운터 초기화) |
| 고객 삭제가 `503 Audit log unavailable` | 040 적용 여부, 서버 로그의 `audit event was not recorded` | 040 적용 또는 Supabase 복구 후 재시도(의도된 fail-closed 동작) |
| 시작 직후 종료 | `[server]` 시작 점검 메시지 | `BUSINESS_ASSISTANT_DEV_AUTO_LOGIN` 제거, 필수 변수(`APP_SUPABASE_URL` 등) 확인, 포트 충돌 확인 |
| 413 | 요청 본문이 한도 초과 | `APP_BODY_LIMIT_BYTES`와 프록시 `client_max_body_size`를 함께 점검(파일은 서명 URL로 직접 올리므로 본문이 커질 일이 거의 없다) |
| 시작 로그에 "서비스 키가 환경에 있지만 무시" 경고 | 일반 API 환경 파일 | 서비스 키를 일반 API 환경에서 제거하고 관리자 환경에만 둔다 |

## 배포 전 점검표

1. `NODE_ENV=production`, `APP_API_HOST=127.0.0.1`(기본), 프록시 IP로 `APP_TRUST_PROXY` 설정.
2. 일반 API 환경에 서비스 키·`BUSINESS_ASSISTANT_DEV_*` 없음.
3. 프록시에서 `/api/v1/admin/` 차단, 443만 공개, 8000·8001 비공개.
4. 마이그레이션 040 적용 후 서버 재시작, `/api/v1/health`와 `/api/v1/health/ready` 확인.
5. 앱의 `BUSINESS_ASSISTANT_API_BASE`가 `https://…/api/v1`인지 확인.
6. 프로세스 자동 재시작과 로그 보관 설정 확인.
