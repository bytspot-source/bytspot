/**
 * Immutable Compliance Token (ICT) signer.
 *
 * ICTs are compact JWTs signed with Ed25519 (EdDSA). Each token records a
 * physical-to-digital handshake (vendor purchase, patch tap, etc.) along
 * with geo / device fingerprints for the Sovereign Shield audit trail.
 *
 * Keys are addressed by a "kid" header so signing keys can be rotated
 * without invalidating outstanding tokens. In production the active key
 * and the verification-key map come from env vars (wired to GCP KMS /
 * Secret Manager later in P4). In development an ephemeral keypair is
 * generated on first use.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export interface ICTResource {
  type: string;                // "booking" | "patch" | "vendor" | ...
  id: string;
}

export interface ICTGeo {
  lat: number;
  lng: number;
  accuracy?: number;
}

export interface ICTDevice {
  fingerprint?: string;
  platform?: string;
}

export interface ICTClaims {
  sub?: string;                // userId (optional — App Clip flows are anonymous until sign-up)
  action: string;              // "vendor.purchase" | "patch.tap" | ...
  resource: ICTResource;
  geo?: ICTGeo;
  device?: ICTDevice;
  iat: number;                 // seconds since epoch
  exp: number;
  jti: string;
  [key: string]: unknown;      // extension slots (e.g. entity, bookingId)
}

interface KeyMaterial {
  activeKid: string;
  privateKey: KeyObject;
  verifiers: Map<string, KeyObject>;
}

let cached: KeyMaterial | null = null;

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function loadFromEnv(): KeyMaterial {
  const activePem = process.env.ICT_SIGNING_KEY_ACTIVE;
  const activeKid = process.env.ICT_SIGNING_KID_ACTIVE;
  const verifiersJson = process.env.ICT_VERIFICATION_KEYS;

  const isDev = (process.env.NODE_ENV || 'development') === 'development';

  if (!activePem || !activeKid) {
    if (!isDev) {
      throw new Error(
        'ICT_SIGNING_KEY_ACTIVE and ICT_SIGNING_KID_ACTIVE are required in production',
      );
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const devKid = `dev-${Date.now().toString(36)}`;
    console.warn(
      `[ictSigner] no ICT signing key configured — generated ephemeral dev key kid=${devKid}`,
    );
    const verifiers = new Map<string, KeyObject>([[devKid, publicKey]]);
    return { activeKid: devKid, privateKey, verifiers };
  }

  const privateKey = createPrivateKey({ key: activePem, format: 'pem' });
  const publicKey = createPublicKey(privateKey);

  const verifiers = new Map<string, KeyObject>([[activeKid, publicKey]]);
  if (verifiersJson) {
    const parsed = JSON.parse(verifiersJson) as Record<string, string>;
    for (const [kid, pem] of Object.entries(parsed)) {
      verifiers.set(kid, createPublicKey({ key: pem, format: 'pem' }));
    }
  }

  return { activeKid, privateKey, verifiers };
}

function getKeys(): KeyMaterial {
  if (!cached) cached = loadFromEnv();
  return cached;
}

/** Test-only: force re-read of env vars on next call. */
export function __resetICTKeysForTests(): void {
  cached = null;
}

export type ICTInput = Omit<ICTClaims, 'iat' | 'exp' | 'jti'> & {
  iat?: number;
  exp?: number;
  jti?: string;
};

/** Sign a set of ICT claims and return a compact JWT string. */
export function signICT(claims: ICTInput, opts: { ttlSec?: number } = {}): string {
  const keys = getKeys();
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? 300;

  const payload: ICTClaims = {
    ...claims,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + ttl,
    jti: claims.jti ?? randomUUID(),
  } as ICTClaims;

  const header = { alg: 'EdDSA', typ: 'ICT', kid: keys.activeKid };
  const signingInput =
    b64urlEncode(Buffer.from(JSON.stringify(header))) +
    '.' +
    b64urlEncode(Buffer.from(JSON.stringify(payload)));

  const signature = cryptoSign(null, Buffer.from(signingInput), keys.privateKey);
  return `${signingInput}.${b64urlEncode(signature)}`;
}

/** Verify a compact ICT string and return its claims. Throws on any failure. */
export function verifyICT(token: string, opts: { clockSkewSec?: number } = {}): ICTClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ICT: malformed token');

  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; typ?: string; kid?: string };
  let payload: ICTClaims;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new Error('ICT: invalid JSON segments');
  }

  if (header.alg !== 'EdDSA' || header.typ !== 'ICT' || !header.kid) {
    throw new Error('ICT: unsupported header');
  }

  const keys = getKeys();
  const pub = keys.verifiers.get(header.kid);
  if (!pub) throw new Error(`ICT: unknown kid ${header.kid}`);

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecode(sigB64);
  const ok = cryptoVerify(null, signingInput, pub, signature);
  if (!ok) throw new Error('ICT: signature invalid');

  const now = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? 60;
  if (typeof payload.exp !== 'number' || payload.exp + skew < now) {
    throw new Error('ICT: token expired');
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + skew) {
    throw new Error('ICT: token issued in the future');
  }
  if (!payload.action || !payload.resource?.type || !payload.resource?.id) {
    throw new Error('ICT: missing required claims');
  }

  return payload;
}

/** Returns the active kid (header.kid that new tokens will carry). */
export function getActiveICTKid(): string {
  return getKeys().activeKid;
}

/**
 * Utility for provisioning — generates a fresh Ed25519 keypair and returns
 * PEM-encoded private + public keys suitable for pasting into env vars.
 */
export function generateEd25519KeyPairPem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
