import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseConfig } from './make-release-config.mjs';

const base = { TAURI_UPDATER_PUBKEY: 'some-public-key' };

test('writes a Windows custom sign command with Tauri file placeholder', () => {
  const { config, warnings } = buildReleaseConfig({ ...base, WINDOWS_SIGN_COMMAND: 'relic sign --file %1 --key azure' });
  assert.equal(config.bundle.windows.signCommand, 'relic sign --file %1 --key azure');
  assert.equal(config.bundle.windows.certificateThumbprint, undefined);
  assert.equal(warnings.some((warning) => warning.includes('코드 서명하지 않은')), false);
});

test('keeps the existing PFX certificate signing configuration', () => {
  const { config, warnings } = buildReleaseConfig({ ...base, WINDOWS_CERTIFICATE_THUMBPRINT: 'AB CD 1234' });
  assert.deepEqual(config.bundle.windows, {
    certificateThumbprint: 'ABCD1234',
    digestAlgorithm: 'sha256',
    timestampUrl: 'http://timestamp.digicert.com',
  });
  assert.equal(warnings.some((warning) => warning.includes('코드 서명하지 않은')), false);
});

test('rejects a custom signing command without exactly one file placeholder', () => {
  assert.throws(() => buildReleaseConfig({ ...base, WINDOWS_SIGN_COMMAND: 'relic sign --key azure' }), /%1/);
  assert.throws(() => buildReleaseConfig({ ...base, WINDOWS_SIGN_COMMAND: 'sign %1 --again %1' }), /한 번/);
  assert.throws(() => buildReleaseConfig({ ...base, WINDOWS_SIGN_COMMAND: 'sign %1\nother' }), /한 줄/);
});

test('rejects combining a custom signer and a PFX certificate thumbprint', () => {
  assert.throws(() => buildReleaseConfig({
    ...base,
    WINDOWS_SIGN_COMMAND: 'sign %1',
    WINDOWS_CERTIFICATE_THUMBPRINT: 'ABCD1234',
  }), /동시에/);
  assert.throws(() => buildReleaseConfig({
    ...base,
    WINDOWS_SIGN_COMMAND: 'sign %1',
    WINDOWS_TIMESTAMP_URL: 'https://timestamp.example.com',
  }), /타임스탬프/);
});
