#!/usr/bin/env node
// Tauri updater 용 latest.json 생성 (OPS-02). tauri build 가 만든 NSIS 설치 파일과 .sig 로 만든다.
//
//   node scripts/release/make-latest-json.mjs --bundle-dir <nsis 폴더> --repo OWNER/REPO --tag v0.2.0 --out <출력 폴더> [--notes "노트"]
//
// 출력 폴더에 GitHub 자산 이름 규칙(공백이 점으로 바뀜)을 피한 이름으로 설치 파일을 복사하고
// (Business-Assistant_<버전>_x64-setup.exe), 그 .sig 와 latest.json 을 만든다. 서명 내용(.sig)은 파일 이름과 무관하다.
// 비밀키는 쓰지 않는다.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function safeAssetName(name) {
  return name.replace(/\s+/g, '-');
}

export function buildLatestJson({ version, notes, pubDate, repo, tag, assetName, signature }) {
  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': {
        signature,
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
      },
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const repo = opt('--repo');
  const tag = opt('--tag');
  if (!opt('--bundle-dir') || !opt('--out') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !tag) {
    throw new Error('사용법: --bundle-dir <폴더> --out <폴더> --repo OWNER/REPO --tag vX.Y.Z');
  }
  const bundleDir = resolve(opt('--bundle-dir'));
  const out = resolve(opt('--out'));
  const version = tag.replace(/^v/, '');
  const exes = readdirSync(bundleDir).filter((f) => f.endsWith('-setup.exe'));
  if (exes.length !== 1) throw new Error(`설치 파일(*-setup.exe)이 정확히 1개여야 합니다: ${exes.length}개 (${bundleDir})`);
  const exe = exes[0];
  let signature;
  try { signature = readFileSync(resolve(bundleDir, `${exe}.sig`), 'utf8').trim(); }
  catch { throw new Error(`${exe}.sig 가 없습니다. TAURI_SIGNING_PRIVATE_KEY 로 서명되었는지(createUpdaterArtifacts) 확인하세요.`); }
  if (!signature) throw new Error(`${exe}.sig 가 비어 있습니다.`);
  const assetName = safeAssetName(exe);
  mkdirSync(out, { recursive: true });
  copyFileSync(resolve(bundleDir, exe), resolve(out, assetName));
  writeFileSync(resolve(out, `${assetName}.sig`), `${signature}\n`, 'utf8');
  const json = buildLatestJson({ version, notes: opt('--notes'), pubDate: new Date().toISOString(), repo, tag, assetName, signature });
  writeFileSync(resolve(out, 'latest.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`생성: ${assetName}, ${assetName}.sig, latest.json (버전 ${version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`::error::${e instanceof Error ? e.message : e}`); process.exit(1); }
}
