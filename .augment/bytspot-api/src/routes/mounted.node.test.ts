import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// An unmounted route file is not dead weight, it is a lie: it declares a
// surface a reader will believe exists. auth.ts and payments.ts were the
// first two files anyone auditing credentials or checkout would open, and
// both had been replaced by tRPC and left in the tree.
test('Every route file is mounted by index.ts', () => {
  const here = __dirname;
  const routes = readdirSync(here)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.node.test.ts'))
    .map((file) => file.replace(/\.ts$/, ''));
  const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');

  const unmounted = routes.filter((route) => !index.includes(`./routes/${route}`));
  assert.deepEqual(unmounted, []);
});
