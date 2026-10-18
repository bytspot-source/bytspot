import { z } from 'zod';

/** Decoded JPEG bytes after client resize. The base64 cap keeps the request under express.json's 1mb limit. */
export const DISH_PHOTO_MAX_BYTES = 600_000;
export const DISH_PHOTO_MAX_DIMENSION = 4096;
export const DISH_PHOTO_TIMEOUT_MS = 12_000;
const DATA_URI_PREFIX = 'data:image/jpeg;base64,';
const MAX_DATA_URI_LENGTH = DATA_URI_PREFIX.length + Math.ceil(DISH_PHOTO_MAX_BYTES / 3) * 4;

export const DISH_PHOTO_DISCLOSURE = 'Bytspot sends this photo to OpenAI to suggest dish names. Bytspot does not save the photo.';

const dishName = z.string().min(1).max(60).regex(/^[\p{L}\p{N}][\p{L}\p{N} '&.-]*$/u);
const confidence = z.enum(['high', 'medium', 'low']);

export const conciergeIdentifyDishInput = z.object({
  image: z.string().max(MAX_DATA_URI_LENGTH),
}).strict();

export const conciergeIdentifyDishOutput = z.object({
  version: z.literal(1),
  status: z.enum(['identified', 'uncertain', 'not_food', 'invalid_photo', 'unavailable']),
  reply: z.string().max(300),
  candidates: z.array(z.object({ name: dishName, confidence }).strict()).max(3),
}).strict();
export type ConciergeIdentifyDishOutput = z.infer<typeof conciergeIdentifyDishOutput>;

/** Strict model output; names are re-validated, prose is never shown. */
export const dishClassificationSchema = z.object({
  isFood: z.boolean(),
  candidates: z.array(z.object({ name: z.string(), confidence })).max(8),
}).strict();
export type DishClassification = z.infer<typeof dishClassificationSchema>;

export class DishPhotoRejected extends Error {}

/**
 * Accept only a baseline/progressive JPEG and drop every APPn segment except
 * JFIF (APP0) and Adobe (APP14), plus comments. EXIF, GPS, XMP and maker notes
 * never leave the server. Malformed structure fails closed.
 */
export function parseDishPhoto(dataUri: string): { jpeg: Buffer; width: number; height: number } {
  if (!dataUri.startsWith(DATA_URI_PREFIX)) throw new DishPhotoRejected('Only JPEG photos are supported.');
  const encoded = dataUri.slice(DATA_URI_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new DishPhotoRejected('Photo encoding is invalid.');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length > DISH_PHOTO_MAX_BYTES) throw new DishPhotoRejected('Photo is too large.');
  return stripJpegMetadata(raw);
}

export function stripJpegMetadata(raw: Buffer): { jpeg: Buffer; width: number; height: number } {
  const bad = (message = 'Photo is not a valid JPEG.') => new DishPhotoRejected(message);
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) throw bad();
  if (raw[raw.length - 2] !== 0xff || raw[raw.length - 1] !== 0xd9) throw bad();
  const kept: Buffer[] = [raw.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset < raw.length) {
    if (raw[offset] !== 0xff) throw bad();
    while (offset < raw.length && raw[offset] === 0xff) offset += 1;
    if (offset >= raw.length) throw bad();
    const marker = raw[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) throw bad();
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { kept.push(Buffer.from([0xff, marker])); continue; }
    if (offset + 2 > raw.length) throw bad();
    const length = raw.readUInt16BE(offset);
    if (length < 2 || offset + length > raw.length) throw bad();
    const segmentEnd = offset + length;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8) throw bad();
      height = raw.readUInt16BE(offset + 3);
      width = raw.readUInt16BE(offset + 5);
    }
    if (marker === 0xda) {
      if (!width || !height) throw bad();
      kept.push(Buffer.from([0xff, marker]), raw.subarray(offset));
      break;
    }
    const metadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!metadata) kept.push(Buffer.from([0xff, marker]), raw.subarray(offset, segmentEnd));
    offset = segmentEnd;
  }
  if (!width || !height) throw bad();
  if (width > DISH_PHOTO_MAX_DIMENSION || height > DISH_PHOTO_MAX_DIMENSION) throw bad('Photo dimensions are too large.');
  return { jpeg: Buffer.concat(kept), width, height };
}

export interface DishPhotoDependencies {
  classify: ((jpeg: Buffer, options: { signal: AbortSignal }) => Promise<unknown>) | null;
  timeoutMs?: number;
}

const REPLIES = {
  identified: 'This looks like the dish below. Confirm it or choose another name to search nearby.',
  uncertain: 'I am not sure which dish this is. Choose the closest name, or type the dish name.',
  noCandidates: 'I could not tell which dish this is. Type the dish name to search nearby.',
  not_food: 'I could not find food in this photo. Try another photo or type the dish name.',
  unavailable: 'Photo identification is unavailable right now. Type the dish name to search nearby.',
} as const;

const unavailable = (): ConciergeIdentifyDishOutput => ({ version: 1, status: 'unavailable', reply: REPLIES.unavailable, candidates: [] });

/** Interpret untrusted model output. Only validated names survive; replies are fixed server text. */
export function interpretClassification(raw: unknown): ConciergeIdentifyDishOutput {
  const parsed = dishClassificationSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  if (!parsed.data.isFood) return { version: 1, status: 'not_food', reply: REPLIES.not_food, candidates: [] };
  const seen = new Set<string>();
  const candidates: ConciergeIdentifyDishOutput['candidates'] = [];
  for (const candidate of parsed.data.candidates) {
    const name = candidate.name.normalize('NFC').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase('en-US');
    if (!dishName.safeParse(name).success || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ name, confidence: candidate.confidence });
    if (candidates.length === 3) break;
  }
  if (!candidates.length) return { version: 1, status: 'uncertain', reply: REPLIES.noCandidates, candidates: [] };
  const identified = candidates[0].confidence === 'high';
  return { version: 1, status: identified ? 'identified' : 'uncertain', reply: identified ? REPLIES.identified : REPLIES.uncertain, candidates };
}

export function createDishPhotoIdentifier(deps: DishPhotoDependencies) {
  return async (input: z.infer<typeof conciergeIdentifyDishInput>): Promise<ConciergeIdentifyDishOutput> => {
    let jpeg: Buffer;
    try {
      ({ jpeg } = parseDishPhoto(input.image));
    } catch (error) {
      if (error instanceof DishPhotoRejected) return { version: 1, status: 'invalid_photo', reply: `${error.message} Try another photo.`, candidates: [] };
      throw error;
    }
    if (!deps.classify) return unavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Dish identification timed out')), deps.timeoutMs ?? DISH_PHOTO_TIMEOUT_MS);
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const raw = await Promise.race([deps.classify(jpeg, { signal: controller.signal }), aborted]);
      return interpretClassification(raw);
    } catch {
      // Never log the photo, the model reply or provider diagnostics.
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  };
}
