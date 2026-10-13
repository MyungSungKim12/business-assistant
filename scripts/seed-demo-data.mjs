#!/usr/bin/env node
// 기능별 [데모] 더미데이터 시드 진입점. 로직은 scripts/seed/ 아래 모듈에 있다. 자세한 사용법은 --help.
import { main } from './seed/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
