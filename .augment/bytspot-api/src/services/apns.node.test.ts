import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { config } from '../config';
import { apnsEndpoint, apnsReadiness, isApnsConfigured } from './apns';

const mutable = config as unknown as Record<string, string>;
const original = { keyId: config.apnsKeyId, teamId: config.apnsTeamId, keyPath: config.apnsKeyPath };

function restore() {
  mutable.apnsKeyId = original.keyId;
  mutable.apnsTeamId = original.teamId;
  mutable.apnsKeyPath = original.keyPath;
}

test('Readiness names the reason push cannot be signed', async (t) => {
  t.after(restore);
  const dir = await mkdtemp(join(tmpdir(), 'apns-'));

  mutable.apnsKeyId = '';
  assert.equal(isApnsConfigured(), false);
  assert.equal(await apnsReadiness(), 'unconfigured');

  // The failure Render actually produces: credentials set, key file absent.
  mutable.apnsKeyId = 'KEYID12345';
  mutable.apnsTeamId = 'TEAMID1234';
  mutable.apnsKeyPath = join(dir, 'missing.p8');
  assert.equal(isApnsConfigured(), true);
  assert.equal(await apnsReadiness(), 'key-unreadable');

  const notAKey = join(dir, 'notakey.p8');
  await writeFile(notAKey, 'not a key');
  mutable.apnsKeyPath = notAKey;
  assert.equal(await apnsReadiness(), 'key-invalid');

  const p8 = join(dir, 'valid.p8');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(p8, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  mutable.apnsKeyPath = p8;
  assert.equal(await apnsReadiness(), 'ready');
});

test('Sandbox and production tokens never cross hosts', () => {
  assert.equal(apnsEndpoint('production'), 'https://api.push.apple.com');
  assert.equal(apnsEndpoint('sandbox'), 'https://api.sandbox.push.apple.com');
});
