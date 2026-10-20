#!/usr/bin/env node
// 릴리스 빌드용 Tauri 추가 설정 생성 (OPS-02). 서명 키·서버 주소는 환경에서만 받고 저장소에는 값을 두지 않는다.
//
//   node scripts/release/make-release-config.mjs [--tag v0.2.0] [--out <경로>]
//   (cd apps/desktop-react && pnpm tauri build --config src-tauri/target/release-config/tauri.release.conf.json)
//
// 환경변수
//   TAURI_UPDATER_PUBKEY               필수. `pnpm tauri signer generate` 가 만든 .pub 파일의 내용(공개키)
//   BUSINESS_ASSISTANT_UPDATE_ENDPOINT 선택. https 업데이트 주소. 없으면 plugins.updater.endpoints 를 비워 둔다(앱에서 "서버 미설정")
//   WINDOWS_CERTIFICATE_THUMBPRINT     선택. 코드 서명 인증서 지문. 없으면 서명하지 않은 설치 파일(경고)
//   WINDOWS_TIMESTAMP_URL              선택. 코드 서명 타임스탬프 서버 (기본 http://timestamp.digicert.com)
//   WINDOWS_SIGN_COMMAND               선택. HSM/클라우드 서명기 명령. `%1` 파일 자리표시자 정확히 1회 포함(인증정보 금지)
//   TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) 업데이트 서명 비밀키 — tauri CLI 가 직접 읽는다. 이 스크립트는 읽지도 출력하지도 않는다.
//
// 버전 일치(tauri.conf.json, Cargo.toml, package.json, 그리고 --tag)도 함께 검사한다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../apps/desktop-react');
export const PUBKEY_PLACEHOLDER = 'REPLACE_WITH_UPDATER_PUBLIC_KEY';

export function readVersions(dir = appDir) {
  const conf = JSON.parse(readFileSync(resolve(dir, 'src-tauri/tauri.conf.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  const cargo = readFileSync(resolve(dir, 'src-tauri/Cargo.toml'), 'utf8');
  const m = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargo.split(/^\[dependencies\]/m)[0]);
  return { tauri: conf.version, package: pkg.version, cargo: m?.[1] };
}

/** 세 파일 버전이 같고, 태그가 있으면 `v` + 버전과 같아야 한다 */
export function assertVersions(v, tag) {
  if (!v.tauri || v.tauri !== v.package || v.tauri !== v.cargo) {
    throw new Error(`버전이 일치하지 않습니다: tauri.conf.json=${v.tauri}, package.json=${v.package}, Cargo.toml=${v.cargo}`);
  }
  if (tag && tag !== `v${v.tauri}`) throw new Error(`태그(${tag})와 앱 버전(v${v.tauri})이 다릅니다.`);
  return v.tauri;
}

export function validateEndpoint(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`BUSINESS_ASSISTANT_UPDATE_ENDPOINT 형식이 올바르지 않습니다: ${raw}`); }
  if (u.protocol !== 'https:') throw new Error('업데이트 서버 주소는 https:// 여야 합니다.');
  return raw;
}

export function buildReleaseConfig(env = process.env) {
  const pubkey = (env.TAURI_UPDATER_PUBKEY ?? '').trim();
  if (!pubkey || pubkey.includes(PUBKEY_PLACEHOLDER)) {
    throw new Error('TAURI_UPDATER_PUBKEY(업데이트 서명 공개키)가 필요합니다. docs/guide/admin/release.md 를 참고하세요.');
  }
  const endpoint = (env.BUSINESS_ASSISTANT_UPDATE_ENDPOINT ?? '').trim();
  const thumbprint = (env.WINDOWS_CERTIFICATE_THUMBPRINT ?? '').replace(/\s/g, '');
  const signCommand = (env.WINDOWS_SIGN_COMMAND ?? '').trim();
  if (signCommand) {
    if (/[\r\n]/.test(signCommand)) throw new Error('WINDOWS_SIGN_COMMAND 는 한 줄 명령이어야 합니다.');
    const placeholders = signCommand.match(/%1/g) ?? [];
    if (placeholders.length !== 1) throw new Error('WINDOWS_SIGN_COMMAND 에는 서명할 파일 경로 자리표시자 %1 이 한 번 있어야 합니다.');
    if (thumbprint) throw new Error('WINDOWS_SIGN_COMMAND 와 WINDOWS_CERTIFICATE_THUMBPRINT 는 동시에 설정할 수 없습니다.');
    if ((env.WINDOWS_TIMESTAMP_URL ?? '').trim()) throw new Error('WINDOWS_SIGN_COMMAND 사용 시 타임스탬프 주소는 서명 명령에 직접 설정해야 합니다.');
  }
  const windows = signCommand
    ? { signCommand }
    : thumbprint
      ? { certificateThumbprint: thumbprint, digestAlgorithm: 'sha256', timestampUrl: (env.WINDOWS_TIMESTAMP_URL ?? '').trim() || 'http://timestamp.digicert.com' }
      : undefined;
  return {
    config: {
      bundle: { createUpdaterArtifacts: true, ...(windows ? { windows } : {}) },
      plugins: { updater: { pubkey, endpoints: endpoint ? [validateEndpoint(endpoint)] : [], windows: { installMode: 'passive' } } },
    },
    warnings: [
      ...(thumbprint || signCommand ? [] : ['WINDOWS_CERTIFICATE_THUMBPRINT 또는 WINDOWS_SIGN_COMMAND 가 없어 코드 서명하지 않은 설치 파일이 만들어집니다(SmartScreen 경고).']),
      ...(signCommand ? ['사용자 지정 서명 명령이 인증서 지문 방식 대신 사용됩니다. 서명 도구가 SHA-256 및 타임스탬프를 직접 적용해야 합니다.'] : []),
      ...(endpoint ? [] : ['BUSINESS_ASSISTANT_UPDATE_ENDPOINT 가 없어 앱의 업데이트 서버가 비어 있습니다.']),
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = resolve(opt('--out') ?? resolve(appDir, 'src-tauri/target/release-config/tauri.release.conf.json'));
  const version = assertVersions(readVersions(), opt('--tag'));
  const { config, warnings } = buildReleaseConfig();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`버전 ${version} 확인, 릴리스 설정 생성: ${out}`);
  for (const w of warnings) console.warn(`::warning::${w}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`::error::${e instanceof Error ? e.message : e}`); process.exit(1); }
}
