import assert from 'node:assert/strict';

/** Recursive subset match (like vitest toMatchObject) for node:test. */
export function assertPartial(actual: unknown, expected: unknown, path = '$'): void {
  if (Array.isArray(expected) && expected.some((e) => e && typeof e === 'object')) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path} length differs`);
    expected.forEach((e, i) => assertPartial((actual as unknown[])[i], e, `${path}[${i}]`));
    return;
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    assert.ok(actual !== null && typeof actual === 'object', `${path} is not an object`);
    for (const [key, value] of Object.entries(expected)) assertPartial((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    return;
  }
  assert.deepEqual(actual, expected, path);
}

export const codes = (notices: Array<{ code: string }>) => notices.map((n) => n.code);
