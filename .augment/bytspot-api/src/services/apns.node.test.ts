import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { config } from '../config';
import {
  apnsEndpoint,
  apnsKeySource,
  apnsReadiness,
  classifyApnsKeyPath,
  isApnsConfigured,
  recaptureApnsSigningStateForTests,
} from './apns';

const mutable = config as unknown as Record<string, string>;
const original = { keyId: config.apnsKeyId, teamId: config.apnsTeamId, keyPath: config.apnsKeyPath };

function restore() {
  mutable.apnsKeyId = original.keyId;
  mutable.apnsTeamId = original.teamId;
  mutable.apnsKeyPath = original.keyPath;
}

async function writeValidKey(path: string) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
}

test('Boot capture names the reason push cannot be signed', async (t) => {
  t.after(restore);
  t.after(() => recaptureApnsSigningStateForTests());
  const dir = await mkdtemp(join(tmpdir(), 'apns-'));

  mutable.apnsKeyId = '';
  assert.equal(isApnsConfigured(), false);
  assert.equal(recaptureApnsSigningStateForTests(), 'unconfigured');

  // The failure Render actually produces: credentials set, key file absent.
  mutable.apnsKeyId = 'KEYID12345';
  mutable.apnsTeamId = 'TEAMID1234';
  mutable.apnsKeyPath = join(dir, 'missing.p8');
  assert.equal(isApnsConfigured(), true);
  assert.equal(recaptureApnsSigningStateForTests(), 'key-unreadable');

  const notAKey = join(dir, 'notakey.p8');
  await writeFile(notAKey, 'not a key');
  mutable.apnsKeyPath = notAKey;
  assert.equal(recaptureApnsSigningStateForTests(), 'key-invalid');

  const p8 = join(dir, 'valid.p8');
  await writeValidKey(p8);
  mutable.apnsKeyPath = p8;
  assert.equal(recaptureApnsSigningStateForTests(), 'ready');
});

// The point of capturing at boot: the verdict is fixed then, so a health poll
// cannot be answered by a filesystem that has changed since. Deleting the key
// from under a running process must not move `ready`, and re-reading per poll
// is exactly what would make this assertion fail.
test('Readiness is the boot verdict, not a fresh probe', async (t) => {
  t.after(restore);
  t.after(() => recaptureApnsSigningStateForTests());
  const dir = await mkdtemp(join(tmpdir(), 'apns-'));
  const p8 = join(dir, 'valid.p8');
  await writeValidKey(p8);

  mutable.apnsKeyId = 'KEYID12345';
  mutable.apnsTeamId = 'TEAMID1234';
  mutable.apnsKeyPath = p8;
  assert.equal(recaptureApnsSigningStateForTests(), 'ready');

  await rm(p8);
  assert.equal(apnsReadiness(), 'ready');
  // And a later boot with the mount still gone reports the truth.
  assert.equal(recaptureApnsSigningStateForTests(), 'key-unreadable');
  assert.equal(apnsReadiness(), 'key-unreadable');
});

// `ready` says the key was read; it does not say the key will still be there
// after the next build. A secret-file mount survives a deploy, a relative path
// resolves against whatever cwd contains at the time. Classifying the shape is
// what makes those two distinguishable from outside the process.
test('The key source is classified by shape, never by whether the read worked', () => {
  assert.equal(classifyApnsKeyPath('/etc/secrets/AuthKey_ABC123.p8'), 'secret-file');
  assert.equal(classifyApnsKeyPath('/opt/render/project/src/AuthKey.p8'), 'absolute-path');
  assert.equal(classifyApnsKeyPath('certs/AuthKey.p8'), 'relative-path');
  assert.equal(classifyApnsKeyPath('./AuthKey.p8'), 'relative-path');
  assert.equal(classifyApnsKeyPath(''), 'unset');
  // A path under a directory that merely starts the same way is not a mount.
  assert.equal(classifyApnsKeyPath('/etc/secrets-backup/AuthKey.p8'), 'absolute-path');
});

// Reported even when the key cannot be read, because that is the case where
// knowing which kind of path was configured tells you what to fix.
test('The key source is captured at boot alongside readiness', async (t) => {
  t.after(restore);
  t.after(() => recaptureApnsSigningStateForTests());
  const dir = await mkdtemp(join(tmpdir(), 'apns-'));
  const p8 = join(dir, 'valid.p8');
  await writeValidKey(p8);

  mutable.apnsKeyId = 'KEYID12345';
  mutable.apnsTeamId = 'TEAMID1234';
  mutable.apnsKeyPath = p8;
  assert.equal(recaptureApnsSigningStateForTests(), 'ready');
  // A tmpdir path is absolute and not a mount, which is precisely the
  // "ready today, gone next deploy" shape this exists to surface.
  assert.equal(apnsKeySource(), 'absolute-path');

  mutable.apnsKeyPath = join(dir, 'missing.p8');
  assert.equal(recaptureApnsSigningStateForTests(), 'key-unreadable');
  assert.equal(apnsKeySource(), 'absolute-path');

  mutable.apnsKeyId = '';
  assert.equal(recaptureApnsSigningStateForTests(), 'unconfigured');
  assert.equal(apnsKeySource(), 'absolute-path');
});

test('Sandbox and production tokens never cross hosts', () => {
  assert.equal(apnsEndpoint('production'), 'https://api.push.apple.com');
  assert.equal(apnsEndpoint('sandbox'), 'https://api.sandbox.push.apple.com');
});
