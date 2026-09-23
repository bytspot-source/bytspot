import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryObjectStore, s3CompatibleStore } from './objectStore';

test('an in-memory store round-trips and delete is idempotent', async () => {
  const store = memoryObjectStore();
  assert.equal(store.configured(), true);
  await store.put({ key: 'vendor/s1/location/l1/cover/m1', bytes: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
  assert.equal((await store.get('vendor/s1/location/l1/cover/m1'))?.toString(), 'jpeg');
  await store.delete('vendor/s1/location/l1/cover/m1');
  assert.equal(await store.get('vendor/s1/location/l1/cover/m1'), null);
  await store.delete('missing');
});

test('a configured S3 store path-styles the bucket and signs SigV4 without leaking the secret', async () => {
  const calls: { url: string; method: string; auth: string | null; sha: string | null; type: string | null }[] = [];
  const store = s3CompatibleStore({
    endpoint: 'https://abc.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'bytspot-media',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret-must-not-appear',
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: String(init?.method),
        auth: headers.get('authorization'),
        sha: headers.get('x-amz-content-sha256'),
        type: headers.get('content-type'),
      });
      return new Response(null, { status: 200 });
    },
  });

  await store.put({
    key: 'vendor/s1/location/l1/cover/m1',
    bytes: Buffer.from('jpeg'),
    mimeType: 'image/jpeg',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://abc.r2.cloudflarestorage.com/bytspot-media/vendor/s1/location/l1/cover/m1');
  assert.match(calls[0].auth ?? '', /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=/);
  assert.ok(!calls[0].auth?.includes('secret-must-not-appear'));
  assert.equal(calls[0].type, 'image/jpeg');
  assert.equal(calls[0].sha?.length, 64);
});

test('a missing object is null rather than a thrown 404', async () => {
  const store = s3CompatibleStore({
    endpoint: 'https://abc.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'bytspot-media',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret',
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(await store.get('vendor/missing'), null);
});
