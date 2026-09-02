import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../lib/db';
import { normalizeEmail } from '../lib/contactHash';
import { mailerIsConfigured, sendVendorSignInCode } from '../lib/email';
import { captureError } from '../lib/observability';
import { signVendorAccessToken } from '../vendor/accessToken';
import { AUTH } from '../vendor/contract';
import {
  createChallenge,
  ipSendCooldownSecs,
  ipSubmitCooldownSecs,
  recordIpSend,
  recordIpSubmit,
  recordSend,
  sendCooldownSecs,
  verifyChallenge,
} from '../vendor/otp';
import {
  issueRefreshToken,
  rotateRefreshToken,
  signOutToken,
  spendRefreshToken,
} from '../vendor/refreshTokens';
import { toSeatDto, toSellerDto, type MembershipDto } from '../vendor/sellerState';

const router = Router();

/**
 * Vendor sign-in. Four routes, all POST, nothing in a query string: a code or a
 * token in a URL lands in access logs, browser history and Referer headers.
 */

export const REFRESH_COOKIE = 'byt_vendor_refresh';
const COOKIE_PATH = '/vendor/auth';

/**
 * Path-scoped so the cookie is not attached to ordinary API calls, and Domain
 * omitted so it stays host-only — setting `.bytspot.app` would hand a 30-day
 * credential to the consumer origin and defeat the origin split.
 *
 * SameSite=Strict plus the path scope is what makes CSRF on these routes
 * impractical. If this is ever loosened to Lax, a double-submit token becomes
 * mandatory.
 */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: AUTH.token.refreshTtlSecs * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: COOKIE_PATH });
}

/**
 * Reads one named cookie from the request header.
 *
 * Hand-parsed rather than pulling in cookie-parser: this is the only cookie the
 * API reads, and a global parser would attach every cookie on the origin to
 * every request object for the sake of one route.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

const codeRequest = z.object({ email: z.string().min(3).max(320) });
const sessionRequest = z.object({
  challengeId: z.string().min(8).max(128),
  code: z.string().min(1).max(16),
});

/** Every seat this person holds, with the business each one sits in. */
async function membershipsFor(userId: string): Promise<MembershipDto[]> {
  const seats = await db.vendorSeat.findMany({
    where: { userId, state: { in: ['INVITED', 'ACTIVE', 'SUSPENDED'] } },
    // One query, with the locations the derivation needs. Read per seat this
    // would be an N+1 on the hottest path in the console.
    include: { seller: { include: { locations: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return seats
    // A closed business is not offered a seat to open. The console would
    // discard it anyway; sending it would only put a dead option on screen.
    .filter((seat) => seat.seller.state !== 'CLOSED')
    .map((seat) => ({
      seller: toSellerDto(seat.seller, seat.seller.locations),
      seat: toSeatDto(seat),
    }));
}

/**
 * Starts a sign-in.
 *
 * Answers 200 whether or not the address maps to a seat. A 404 here would turn
 * this route into an oracle for which businesses are on Bytspot and who runs
 * them, so the only observable difference is whether an email arrives.
 */
router.post('/vendor/auth/code', async (req, res) => {
  const parsed = codeRequest.safeParse(req.body);
  const email = normalizeEmail(parsed.success ? parsed.data.email : null);
  if (!email) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }

  // Checked before anything else: a mailer that silently drops the code would
  // have us return a cheerful 200 to someone who can never sign in.
  if (!mailerIsConfigured()) {
    res.status(503).json({ error: 'Sign-in is temporarily unavailable' });
    return;
  }

  try {
    const ip = req.ip ?? 'unknown';
    const ipCooldown = await ipSendCooldownSecs(ip);
    if (ipCooldown > 0) {
      res.set('Retry-After', String(ipCooldown)).status(429).json({ error: 'Too many requests' });
      return;
    }

    const cooldown = await sendCooldownSecs(email);
    if (cooldown > 0) {
      res.set('Retry-After', String(cooldown)).status(429).json({ error: 'Too many requests' });
      return;
    }

    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    const seats = user
      ? await db.vendorSeat.count({
          where: { userId: user.id, state: { in: ['INVITED', 'ACTIVE', 'SUSPENDED'] } },
        })
      : 0;

    // The IP limit is recorded for every attempt, existing address or not,
    // because it is the limit that actually bounds an enumeration sweep.
    await recordIpSend(ip);

    if (!user || seats === 0) {
      // Deliberately indistinguishable from success. No email, no challenge,
      // same status and shape as the branch below.
      res.status(200).json({ challengeId: `chal_${'0'.repeat(32)}` });
      return;
    }

    const challenge = await createChallenge(email, user.id);
    await sendVendorSignInCode(email, challenge.code, Math.round(AUTH.code.ttlSecs / 60));
    await recordSend(email);

    res.status(200).json({ challengeId: challenge.id });
  } catch (err) {
    captureError(err, { route: 'vendor/auth/code' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Completes a sign-in: code for an access token, a refresh cookie, and every
 * seat the person holds. Which seat they act as is a separate choice the
 * console makes once identity is settled.
 */
router.post('/vendor/auth/session', async (req, res) => {
  const parsed = sessionRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'challengeId and code are required' });
    return;
  }

  try {
    const ip = req.ip ?? 'unknown';
    const ipCooldown = await ipSubmitCooldownSecs(ip);
    if (ipCooldown > 0) {
      res.set('Retry-After', String(ipCooldown)).status(429).json({ error: 'Too many requests' });
      return;
    }
    await recordIpSubmit(ip);

    const verdict = await verifyChallenge(parsed.data.challengeId, parsed.data.code);
    if (!verdict.ok) {
      // 423 only for a spent challenge, so the client can say "start again"
      // rather than "check the code". Neither status reveals whether the
      // address exists.
      res.status(verdict.reason === 'locked' ? 423 : 401).json({ error: 'Invalid or expired code' });
      return;
    }

    // The challenge carries the account it was minted for, so there is no
    // address to re-resolve and nothing for a caller to substitute.
    const user = await db.user.findUnique({ where: { id: verdict.userId } });
    if (!user) {
      res.status(403).json({ error: 'No seats for this account' });
      return;
    }

    const memberships = await membershipsFor(user.id);
    // A verified person with nothing to open is told so plainly. This is 403
    // rather than 200-with-an-empty-list because the console has a screen for
    // it, and an empty console is a worse answer than an explanation.
    if (memberships.length === 0) {
      res.status(403).json({ error: 'No seats for this account' });
      return;
    }

    setRefreshCookie(res, await issueRefreshToken(user.id));
    res.status(200).json({
      accessToken: signVendorAccessToken({ userId: user.id, email: user.email }),
      expiresInSecs: AUTH.token.accessTtlSecs,
      person: { id: user.id, email: user.email },
      memberships,
    });
  } catch (err) {
    captureError(err, { route: 'vendor/auth/session' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Trades the refresh cookie for a new access token, and replaces the cookie.
 *
 * Authenticated entirely by the cookie. Rotation is single-use: presenting a
 * spent token revokes the whole family, because a legitimate client never
 * replays — it received the replacement in the same response as the request
 * that spent the original.
 */
router.post('/vendor/auth/refresh', async (req, res) => {
  const presented = readCookie(req, REFRESH_COOKIE);
  if (!presented) {
    res.status(401).json({ error: 'No session' });
    return;
  }

  try {
    const verdict = await spendRefreshToken(presented);
    if (!verdict.ok) {
      clearRefreshCookie(res);
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    const user = await db.user.findUnique({ where: { id: verdict.userId } });
    if (!user) {
      clearRefreshCookie(res);
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    // Re-read on every refresh rather than trusting the token: a business
    // suspended an hour ago must not keep its console for the rest of the
    // refresh window because its seat looked fine at sign-in.
    const memberships = await membershipsFor(user.id);
    if (memberships.length === 0) {
      clearRefreshCookie(res);
      res.status(403).json({ error: 'No seats for this account' });
      return;
    }

    setRefreshCookie(res, await rotateRefreshToken(verdict.userId, verdict.familyId));
    res.status(200).json({
      accessToken: signVendorAccessToken({ userId: user.id, email: user.email }),
      expiresInSecs: AUTH.token.accessTtlSecs,
    });
  } catch (err) {
    captureError(err, { route: 'vendor/auth/refresh' });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Ends this sign-in. Always 204: the client has already dropped its in-memory
 * token by the time this runs, and a failure it cannot act on is not worth
 * reporting.
 */
router.post('/vendor/auth/sign-out', async (req, res) => {
  const presented = readCookie(req, REFRESH_COOKIE);
  try {
    if (presented) await signOutToken(presented);
  } catch (err) {
    captureError(err, { route: 'vendor/auth/sign-out' });
  }
  clearRefreshCookie(res);
  res.status(204).end();
});

export default router;
