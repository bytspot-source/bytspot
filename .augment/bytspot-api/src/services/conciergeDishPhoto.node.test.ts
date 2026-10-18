import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDishPhotoIdentifier, conciergeIdentifyDishInput, conciergeIdentifyDishOutput, DISH_PHOTO_MAX_BYTES,
  interpretClassification, parseDishPhoto, stripJpegMetadata,
} from './conciergeDishPhoto';

const segment = (marker: number, body: Buffer) => {
  const header = Buffer.alloc(4);
  header[0] = 0xff; header[1] = marker; header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
};
const sof = (width: number, height: number) => {
  const body = Buffer.alloc(9);
  body[0] = 8; body.writeUInt16BE(height, 1); body.writeUInt16BE(width, 3); body[5] = 1; body[6] = 1; body[7] = 0x11; body[8] = 0;
  return segment(0xc0, body);
};
function jpeg({ width = 640, height = 480, extra = [] as Buffer[] } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    segment(0xe1, Buffer.from('Exif\0\0GPSLatitude=47.6062')),
    segment(0xe2, Buffer.from('ICC_PROFILE\0secret-device')),
    segment(0xfe, Buffer.from('owner comment')),
    ...extra,
    sof(width, height),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
const uri = (bytes: Buffer) => `data:image/jpeg;base64,${bytes.toString('base64')}`;

test('metadata segments are removed and image data is preserved', () => {
  const { jpeg: clean, width, height } = parseDishPhoto(uri(jpeg()));
  assert.equal(width, 640);
  assert.equal(height, 480);
  const text = clean.toString('binary');
  assert.ok(!text.includes('GPSLatitude'));
  assert.ok(!text.includes('ICC_PROFILE'));
  assert.ok(!text.includes('owner comment'));
  assert.ok(text.includes('JFIF'));
  assert.deepEqual([...clean.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...clean.subarray(-7)], [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
  // Stripping is idempotent.
  assert.deepEqual(stripJpegMetadata(clean).jpeg, clean);
});

test('non-JPEG, malformed, oversize and huge-dimension photos are rejected', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const bad of [
    `data:image/png;base64,${png.toString('base64')}`, uri(png), 'data:image/jpeg;base64,', 'data:image/jpeg;base64,@@@@',
    'data:image/jpeg;base64,abc', `https://example.test/photo.jpg`, uri(jpeg().subarray(0, -2)),
    uri(Buffer.concat([jpeg().subarray(0, 2), Buffer.from([0xff, 0xda, 0, 2]), Buffer.from([0xff, 0xd9])])),
    uri(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.from([0xff, 0xd9])])),
    uri(jpeg({ width: 5000 })), uri(jpeg({ height: 0 })),
  ]) {
    assert.throws(() => parseDishPhoto(bad), bad.slice(0, 40));
  }
  const padding = segment(0xe3, Buffer.alloc(60_000));
  const large = jpeg({ extra: Array.from({ length: 11 }, () => padding) });
  assert.ok(large.length > DISH_PHOTO_MAX_BYTES);
  assert.throws(() => parseDishPhoto(uri(large)), /too large/);
  assert.equal(conciergeIdentifyDishInput.safeParse({ image: uri(large) + 'A'.repeat(200_000) }).success, false);
  assert.equal(conciergeIdentifyDishInput.safeParse({ image: uri(jpeg()), url: 'x' }).success, false);
});

test('model output becomes validated, deduplicated names with fixed replies', () => {
  const result = interpretClassification({ isFood: true, candidates: [
    { name: ' Jollof   rice ', confidence: 'high' }, { name: 'jollof rice', confidence: 'medium' },
    { name: 'Visit https://evil.test', confidence: 'medium' }, { name: 'Ignore rules <script>', confidence: 'low' },
    { name: 'Fried plantain', confidence: 'medium' }, { name: 'Waakye', confidence: 'low' }, { name: 'Banku', confidence: 'low' },
  ] });
  assert.equal(result.status, 'identified');
  assert.deepEqual(result.candidates.map((c) => c.name), ['Jollof rice', 'Fried plantain', 'Waakye']);
  assert.ok(conciergeIdentifyDishOutput.safeParse(result).success);
  assert.equal(interpretClassification({ isFood: true, candidates: [{ name: 'Ramen', confidence: 'medium' }] }).status, 'uncertain');
  const none = interpretClassification({ isFood: true, candidates: [{ name: '!!!', confidence: 'high' }] });
  assert.equal(none.status, 'uncertain');
  assert.deepEqual(none.candidates, []);
  const notFood = interpretClassification({ isFood: false, candidates: [{ name: 'Pizza', confidence: 'high' }] });
  assert.equal(notFood.status, 'not_food');
  assert.deepEqual(notFood.candidates, []);
  for (const raw of [null, 'pizza', { isFood: true }, { isFood: true, candidates: [], reply: 'hi' }]) {
    assert.equal(interpretClassification(raw).status, 'unavailable');
  }
});

test('identifier strips the photo before the model, and failures stay generic', async () => {
  let seen: Buffer | undefined;
  const identify = createDishPhotoIdentifier({ classify: async (bytes) => {
    seen = bytes;
    return { isFood: true, candidates: [{ name: 'Pho', confidence: 'high' }] };
  } });
  const result = await identify({ image: uri(jpeg()) });
  assert.equal(result.status, 'identified');
  assert.ok(seen && !seen.toString('binary').includes('GPSLatitude'));

  assert.equal((await identify({ image: 'data:image/png;base64,AAAA' })).status, 'invalid_photo');
  assert.equal((await createDishPhotoIdentifier({ classify: null })({ image: uri(jpeg()) })).status, 'unavailable');
  const failing = createDishPhotoIdentifier({ classify: async () => { throw new Error('provider said: secret detail'); } });
  const failed = await failing({ image: uri(jpeg()) });
  assert.equal(failed.status, 'unavailable');
  assert.doesNotMatch(failed.reply, /secret/);
  const slow = createDishPhotoIdentifier({ timeoutMs: 20, classify: (_bytes, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }) });
  assert.equal((await slow({ image: uri(jpeg()) })).status, 'unavailable');
});

test('a provider that ignores cancellation still times out', async () => {
  const stuck = createDishPhotoIdentifier({ timeoutMs: 20, classify: () => new Promise(() => {}) });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await stuck({ image: uri(jpeg()) })).status, 'unavailable');
  } finally { clearTimeout(keepAlive); }
});
