import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const configPath = path.join(__dirname, 'index.ts');
const tsx = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

function loadConfig(env: Record<string, string>, script: string): { status: number; output: string } {
  try {
    const output = execFileSync(tsx, ['-e', `const { config } = require(${JSON.stringify(configPath)}); ${script}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A clean environment: inheriting the developer's own .env would hide the failure.
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const productionDatabase = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://example/db' };

test('The server still refuses to start in production without JWT_SECRET', () => {
  const result = loadConfig({ ...productionDatabase, CONTACT_HASH_SALT: 'a-real-salt' }, 'console.log("started");');
  assert.equal(result.status, 1);
  assert.match(result.output, /JWT_SECRET: Required/);
});

test('A scheduled job boots with only a database, without the API secrets', () => {
  const result = loadConfig(
    { ...productionDatabase, BYTSPOT_RUNTIME: 'job' },
    'console.log("db:" + (config.databaseUrl.length > 0));',
  );
  assert.equal(result.status, 0);
  assert.match(result.output, /db:true/);
});

test('The purge job declares its own runtime, so a missing scheduler variable cannot stop the deletion promise', () => {
  const script = path.join(__dirname, '..', 'scripts', 'purgeAccounts.ts');
  let output = '';
  try {
    // Unreachable database on purpose: the job must get far enough to try.
    output = execFileSync(tsx, [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', DATABASE_URL: 'postgresql://user@127.0.0.1:1/nope' },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert.doesNotMatch(output, /JWT_SECRET/, 'the job must not require the API request-signing secret');
  assert.doesNotMatch(output, /Environment variable validation failed/);
});

test('A job that reads a secret it was not given fails loudly rather than using an empty one', () => {
  for (const [field, expected] of [['jwtSecret', /does not sign tokens/], ['contactHashSalt', /does not hash contacts/]] as const) {
    const result = loadConfig({ ...productionDatabase, BYTSPOT_RUNTIME: 'job' }, `config.${field};`);
    assert.equal(result.status, 1, `${field} should have thrown`);
    assert.match(result.output, expected);
  }
});
