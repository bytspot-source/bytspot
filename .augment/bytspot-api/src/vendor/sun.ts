import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

/**
 * The fresh code an NTAG 424 DNA chip adds to its link on every tap (NXP's
 * "SUN" message, AN12196): bytspot.app/BYT424-0301?picc_data=…&cmac=….
 *
 * `picc_data` is the chip's UID and tap counter, encrypted with the item's
 * meta key. `cmac` is a MAC from a session key that only the item's file key
 * and that exact UID and counter give. So a copied link carries an old
 * counter, and a copied chip cannot make a new code without the keys.
 *
 * Both keys are derived from one master key per item number, so the keys
 * never leave the server and no item's keys open another.
 */

export interface SunCode {
  piccData: string;
  cmac: string;
}

export interface SunTap {
  /** The chip's 7-byte UID, as upper-case hex. */
  uid: string;
  /** The chip's tap counter. It goes up by one on every tap. */
  counter: number;
}

const BLOCK = 16;
const ZERO = Buffer.alloc(BLOCK);

function aesBlock(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function shiftLeft(block: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i++) out[i] = ((block[i] << 1) | (i + 1 < BLOCK ? block[i + 1] >> 7 : 0)) & 0xff;
  if (block[0] & 0x80) out[BLOCK - 1] ^= 0x87;
  return out;
}

function xor(a: Buffer, b: Buffer): Buffer {
  return Buffer.from(a.map((byte, i) => byte ^ b[i]));
}

/** AES-128-CMAC (RFC 4493). */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  const k1 = shiftLeft(aesBlock(key, ZERO));
  const k2 = shiftLeft(k1);
  const blocks = Math.max(1, Math.ceil(message.length / BLOCK));
  const whole = message.length > 0 && message.length % BLOCK === 0;
  const tail = message.subarray((blocks - 1) * BLOCK);
  const last = whole ? xor(tail, k1) : xor(Buffer.concat([tail, Buffer.from([0x80]), ZERO]).subarray(0, BLOCK), k2);
  let state: Buffer = ZERO;
  for (let i = 0; i < blocks - 1; i++) state = aesBlock(key, xor(state, message.subarray(i * BLOCK, (i + 1) * BLOCK)));
  return aesBlock(key, xor(state, last));
}

/** An item's two keys: the meta key reads `picc_data`, the file key makes `cmac`. */
export function itemKeys(master: Buffer, serial: string): { metaKey: Buffer; fileKey: Buffer } {
  return {
    metaKey: aesCmac(master, Buffer.from(`\x01bytspot-sun-meta:${serial}`)),
    fileKey: aesCmac(master, Buffer.from(`\x02bytspot-sun-file:${serial}`)),
  };
}

const HEX = (length: number) => new RegExp(`^[0-9a-f]{${length}}$`, 'i');

/** The fresh code on a tapped link, if it has one. A value with no code reads as undefined. */
export function parseSunCode(raw: string): SunCode | undefined {
  const query = raw.trim().split('?')[1];
  if (!query) return undefined;
  const params = new URLSearchParams(query);
  const piccData = params.get('picc_data');
  const cmac = params.get('cmac');
  if (piccData === null && cmac === null) return undefined;
  return { piccData: piccData ?? '', cmac: cmac ?? '' };
}

/** The UID and counter a code was made from, or undefined when it does not check out. */
export function verifySun(keys: { metaKey: Buffer; fileKey: Buffer }, code: SunCode): SunTap | undefined {
  if (!HEX(32).test(code.piccData) || !HEX(16).test(code.cmac)) return undefined;
  const decipher = createDecipheriv('aes-128-cbc', keys.metaKey, ZERO).setAutoPadding(false);
  const picc = Buffer.concat([decipher.update(Buffer.from(code.piccData, 'hex')), decipher.final()]);
  // Tag byte: UID mirrored, counter mirrored, a 7-byte UID.
  if ((picc[0] & 0xc0) !== 0xc0 || (picc[0] & 0x0f) !== 7) return undefined;
  const uid = picc.subarray(1, 8);
  const counterBytes = picc.subarray(8, 11);
  const sv2 = Buffer.concat([Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]), uid, counterBytes]);
  const sessionKey = aesCmac(keys.fileKey, sv2);
  const full = aesCmac(sessionKey, Buffer.alloc(0));
  const mac = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
  if (!timingSafeEqual(mac, Buffer.from(code.cmac, 'hex'))) return undefined;
  return { uid: uid.toString('hex').toUpperCase(), counter: counterBytes.readUIntLE(0, 3) };
}
