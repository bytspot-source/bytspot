import { createPublicKey, verify as verifySignature } from 'crypto';

const MAX_ID_TOKEN_LENGTH = 8_192;
const CLOCK_SKEW_SECONDS = 60;

type JsonRecord = Record<string, unknown>;

type JwksFetcher = (url: string) => Promise<unknown>;

export type ProviderName = 'apple' | 'google';

export interface VerifiedProviderIdentity {
  provider: ProviderName;
  subject: string;
  email?: string;
  name?: string;
}

type Audience = string | readonly string[];

interface ProviderVerificationOptions {
  provider: ProviderName;
  issuer: string;
  audience: Audience;
  jwksURL: string;
  requireVerifiedEmail: boolean;
}

const providerOptions: Record<ProviderName, Omit<ProviderVerificationOptions, 'audience'>> = {
  apple: {
    provider: 'apple',
    issuer: 'https://appleid.apple.com',
    jwksURL: 'https://appleid.apple.com/auth/keys',
    // Apple IDs created with a token email must prove that email claim too.
    requireVerifiedEmail: true,
  },
  google: {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    jwksURL: 'https://www.googleapis.com/oauth2/v3/certs',
    requireVerifiedEmail: true,
  },
};

const jwksCache = new Map<string, { expiresAt: number; keys: JsonRecord[] }>();
const unknownKidRefreshAt = new Map<string, number>();
const JWKS_CACHE_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 60_000;

function parseJwtPart(value: string): JsonRecord {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as JsonRecord;
  } catch {
    throw new Error('Invalid provider identity token');
  }
}

function stringClaim(claims: JsonRecord, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function allowedAudiences(expected: Audience): string[] {
  const values = typeof expected === 'string' ? [expected] : [...expected];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function audienceMatches(value: unknown, expected: Audience): boolean {
  // Native tokens carry exactly one client audience. Reject multi-aud arrays
  // so a token cannot satisfy the check without an unambiguous azp.
  const allowed = allowedAudiences(expected);
  return typeof value === 'string' && allowed.includes(value);
}

/** Full-app Services/bundle ID plus the App Clip bundle (`<id>.Clip`). */
export function appleIdentityAudiences(appleClientId: string): string[] {
  const primary = appleClientId.trim();
  if (!primary) return [];
  if (primary.endsWith('.Clip')) return [primary];
  return [primary, `${primary}.Clip`];
}

function emailIsVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

function normalizedEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

async function fetchJwks(url: string): Promise<unknown> {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return { keys: cached.keys };

  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('Provider signing keys unavailable');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !Array.isArray((body as JsonRecord).keys)) {
    throw new Error('Provider signing keys unavailable');
  }
  const keys = (body as { keys: unknown[] }).keys.filter((key): key is JsonRecord => !!key && typeof key === 'object' && !Array.isArray(key));
  if (keys.length === 0) throw new Error('Provider signing keys unavailable');
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_CACHE_MS });
  return { keys };
}

/**
 * Verifies an Apple or Google OpenID Connect ID token. The caller supplies the
 * expected audience from deployment configuration; token contents are never
 * logged or persisted.
 */
export async function verifyProviderIdToken(
  provider: ProviderName,
  idToken: string,
  audience: Audience,
  getJwks: JwksFetcher = fetchJwks,
): Promise<VerifiedProviderIdentity> {
  if (allowedAudiences(audience).length === 0 || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
    throw new Error('Invalid provider identity token');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid provider identity token');
  const header = parseJwtPart(parts[0]);
  const claims = parseJwtPart(parts[1]);
  const kid = stringClaim(header, 'kid');
  if (header.alg !== 'RS256' || !kid) throw new Error('Invalid provider identity token');

  const options: ProviderVerificationOptions = { ...providerOptions[provider], audience };
  const keysFrom = (jwks: unknown): JsonRecord[] => jwks && typeof jwks === 'object' && Array.isArray((jwks as JsonRecord).keys)
    ? (jwks as JsonRecord).keys as JsonRecord[]
    : [];
  let keys = keysFrom(await getJwks(options.jwksURL));
  let jwk = keys.find((key) => key.kid === kid && key.kty === 'RSA' && key.use !== 'enc');
  // Providers rotate signing keys. An unknown key may be newer than a cached
  // JWKS, but rate-limit cache refreshes so random kids cannot amplify requests.
  const lastRefresh = unknownKidRefreshAt.get(options.jwksURL) ?? 0;
  if (!jwk && Date.now() - lastRefresh >= UNKNOWN_KID_REFRESH_COOLDOWN_MS) {
    unknownKidRefreshAt.set(options.jwksURL, Date.now());
    jwksCache.delete(options.jwksURL);
    keys = keysFrom(await getJwks(options.jwksURL));
    jwk = keys.find((key) => key.kid === kid && key.kty === 'RSA' && key.use !== 'enc');
  }
  if (!jwk) throw new Error('Invalid provider identity token');

  let signatureIsValid = false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    signatureIsValid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
  } catch {
    throw new Error('Invalid provider identity token');
  }
  if (!signatureIsValid) throw new Error('Invalid provider identity token');

  const now = Math.floor(Date.now() / 1_000);
  const exp = claims.exp;
  const nbf = claims.nbf;
  const iat = claims.iat;
  if (claims.iss !== options.issuer || !audienceMatches(claims.aud, options.audience) ||
      typeof exp !== 'number' || exp <= now - CLOCK_SKEW_SECONDS ||
      (typeof nbf === 'number' && nbf > now + CLOCK_SKEW_SECONDS) ||
      (typeof iat === 'number' && iat > now + CLOCK_SKEW_SECONDS)) {
    throw new Error('Invalid provider identity token');
  }

  const subject = stringClaim(claims, 'sub');
  if (!subject || subject.length > 255) throw new Error('Invalid provider identity token');
  const email = normalizedEmail(stringClaim(claims, 'email'));
  // Existing Apple identities may sign in after Apple's one-time email claim
  // has disappeared. When any provider email is present and used, require it
  // to be provider-verified before it can create a Bytspot account.
  if (email && options.requireVerifiedEmail && !emailIsVerified(claims.email_verified)) {
    throw new Error('Invalid provider identity token');
  }
  if (provider === 'google' && !email) throw new Error('Invalid provider identity token');
  const name = stringClaim(claims, 'name')?.slice(0, 100);
  return {
    provider,
    subject,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

/** Test-only cache reset; provider tokens and signing keys are never exposed. */
export function resetProviderJwksCacheForTests(): void {
  jwksCache.clear();
  unknownKidRefreshAt.clear();
}
