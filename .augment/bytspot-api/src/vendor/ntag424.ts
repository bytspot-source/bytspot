import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { aesCmac } from './sun';

/**
 * The NTAG 424 DNA commands that turn a chip's fresh code on (NXP AN12196).
 *
 * The phone only passes APDUs between the chip and the server. The server
 * authenticates with the chip (AuthenticateEV2First), then sends its commands
 * encrypted and MACed (CommMode.Full), so the keys never leave the server.
 */

const ZERO = Buffer.alloc(16);

function aes(mode: 'encrypt' | 'decrypt', key: Buffer, iv: Buffer | null, data: Buffer): Buffer {
  const algorithm = iv ? 'aes-128-cbc' : 'aes-128-ecb';
  const cipher = mode === 'encrypt' ? createCipheriv(algorithm, key, iv) : createDecipheriv(algorithm, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function macT(key: Buffer, data: Buffer): Buffer {
  const full = aesCmac(key, data);
  return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
}

function rotateLeft(data: Buffer): Buffer {
  return Buffer.concat([data.subarray(1), data.subarray(0, 1)]);
}

function le16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function le24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
}

/** Status words at the end of a response. */
export function statusOf(response: Buffer): string {
  return response.subarray(-2).toString('hex').toUpperCase();
}

export const SELECT_APP = Buffer.from('00A4040007D276000085010100', 'hex');
export const SELECT_NDEF_FILE = Buffer.from('00A4000C02E104', 'hex');
export const READ_NDEF = Buffer.from('00B0000000', 'hex');

/** AuthenticateEV2First, part 1, with key `keyNo`. */
export function authStart(keyNo: number): Buffer {
  return Buffer.from([0x90, 0x71, 0x00, 0x00, 0x02, keyNo, 0x00, 0x00]);
}

/** Part 2: the chip's encrypted RndB answered with RndA and RndB rotated. */
export function authAnswer(key: Buffer, response: Buffer, rndA: Buffer = randomBytes(16)): { apdu: Buffer; rndA: Buffer; rndB: Buffer } | undefined {
  if (response.length !== 18 || statusOf(response) !== '91AF') return undefined;
  const rndB = aes('decrypt', key, ZERO, response.subarray(0, 16));
  const body = aes('encrypt', key, ZERO, Buffer.concat([rndA, rotateLeft(rndB)]));
  return { apdu: Buffer.concat([Buffer.from('90AF000020', 'hex'), body, Buffer.from([0x00])]), rndA, rndB };
}

export interface ChipSession {
  encKey: Buffer;
  macKey: Buffer;
  ti: Buffer;
  counter: number;
}

/** The chip's last answer checked, and the session keys derived from both randoms. */
export function authFinish(key: Buffer, rndA: Buffer, rndB: Buffer, response: Buffer): ChipSession | undefined {
  if (response.length !== 34 || statusOf(response) !== '9100') return undefined;
  const plain = aes('decrypt', key, ZERO, response.subarray(0, 32));
  const ti = plain.subarray(0, 4);
  const echoed = plain.subarray(4, 20);
  const expected = rotateLeft(rndA);
  if (!timingSafeEqual(echoed, expected)) return undefined;
  const mixed = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) mixed[i] = rndA[2 + i] ^ rndB[i];
  const context = Buffer.concat([rndA.subarray(0, 2), mixed, rndB.subarray(6), rndA.subarray(8)]);
  return {
    encKey: aesCmac(key, Buffer.concat([Buffer.from('A55A00010080', 'hex'), context])),
    macKey: aesCmac(key, Buffer.concat([Buffer.from('5AA500010080', 'hex'), context])),
    ti: Buffer.from(ti),
    counter: 0,
  };
}

/** A command in CommMode.Full. Moves the session's counter on. */
export function fullCommand(session: ChipSession, ins: number, header: Buffer, data: Buffer): Buffer {
  const iv = aes('encrypt', session.encKey, null, Buffer.concat([Buffer.from('A55A', 'hex'), session.ti, le16(session.counter), Buffer.alloc(8)]));
  const padded = Buffer.concat([data, Buffer.from([0x80]), Buffer.alloc(15 - (data.length % 16))]);
  const encrypted = aes('encrypt', session.encKey, iv, padded);
  const mac = macT(session.macKey, Buffer.concat([Buffer.from([ins]), le16(session.counter), session.ti, header, encrypted]));
  session.counter += 1;
  const body = Buffer.concat([header, encrypted, mac]);
  return Buffer.concat([Buffer.from([0x90, ins, 0x00, 0x00, body.length]), body, Buffer.from([0x00])]);
}

/** True when a response to the command sent at `counter` is `9100` with the chip's MAC. */
export function responseVerified(session: Pick<ChipSession, 'macKey' | 'ti'>, counter: number, response: Buffer): boolean {
  if (response.length < 10 || statusOf(response) !== '9100') return false;
  const data = response.subarray(0, -10);
  const mac = response.subarray(-10, -2);
  return timingSafeEqual(mac, macT(session.macKey, Buffer.concat([Buffer.from([0x00]), le16(counter + 1), session.ti, data])));
}

/** ChangeKey. Another key needs the old one; the authenticated key ends the session. */
export function changeKey(session: ChipSession, keyNo: number, newKey: Buffer, oldKey: Buffer, version = 0x01): Buffer {
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE((~crc32(newKey)) >>> 0);
  const xored = Buffer.from(newKey.map((byte, i) => byte ^ oldKey[i]));
  const data = keyNo === 0 ? Buffer.concat([newKey, Buffer.from([version])]) : Buffer.concat([xored, Buffer.from([version]), crc]);
  return fullCommand(session, 0xc4, Buffer.from([keyNo]), data);
}

/** Which key does what once the code is on. */
export const KEY_APP = 0;
export const KEY_FILE_READ = 1;
export const KEY_META_READ = 2;

export interface NdefTemplate {
  /** The whole NDEF file: its length, then one URI record. */
  file: Buffer;
  piccOffset: number;
  macOffset: number;
}

/** `https://bytspot.app/<serial>?picc_data=…&cmac=…` with zeros where the chip writes its code. */
export function ndefTemplate(serial: string): NdefTemplate {
  const head = `bytspot.app/${serial}?picc_data=`;
  const uri = `${head}${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`;
  const payload = Buffer.concat([Buffer.from([0x04]), Buffer.from(uri, 'ascii')]);
  const record = Buffer.concat([Buffer.from([0xd1, 0x01, payload.length, 0x55]), payload]);
  const file = Buffer.concat([Buffer.from([0x00, record.length]), record]);
  const piccOffset = 2 + 4 + 1 + head.length;
  return { file, piccOffset, macOffset: piccOffset + 32 + '&cmac='.length };
}

export function writeNdef(template: NdefTemplate): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0xd6, 0x00, 0x00, template.file.length]), template.file]);
}

/**
 * ChangeFileSettings on the NDEF file: anyone may read it, only key 0 may
 * write or change it, and each read mirrors the encrypted UID and counter and
 * a MAC over nothing at the offsets of the template.
 */
export function enableSdm(session: ChipSession, template: NdefTemplate): Buffer {
  const data = Buffer.concat([
    Buffer.from([0x40, 0x00, 0xe0, 0xc1]),
    Buffer.from([0xf0 | KEY_FILE_READ, (KEY_META_READ << 4) | KEY_FILE_READ]),
    le24(template.piccOffset),
    le24(template.macOffset),
    le24(template.macOffset),
  ]);
  return fullCommand(session, 0x5f, Buffer.from([0x02]), data);
}

/** The URL in an NDEF file read back from the chip. */
export function readNdefUrl(response: Buffer): string | undefined {
  if (statusOf(response) !== '9000' || response.length < 9) return undefined;
  const length = response.readUInt16BE(0);
  const record = response.subarray(2, 2 + length);
  if (record[0] !== 0xd1 || record[1] !== 0x01 || record[3] !== 0x55) return undefined;
  const payload = record.subarray(4, 4 + record[2]);
  return payload[0] === 0x04 ? `https://${payload.subarray(1).toString('ascii')}` : undefined;
}
