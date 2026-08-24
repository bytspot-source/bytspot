import { connect, type ClientHttp2Session } from 'node:http2';
import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { config } from '../config';
import type { IosPushEnvironment } from './iosPushDevices';

export interface ApnsPayload {
  aps: {
    alert: { title: string; body: string };
    sound: 'default';
  };
  url: string;
  type: string;
}

export type ApnsSendStatus = 'sent' | 'permanent-failure' | 'temporary-failure' | 'skipped';

let cachedProviderToken: { value: string; expiresAt: number } | null = null;

export function isApnsConfigured(): boolean {
  return Boolean(config.apnsKeyId && config.apnsTeamId && config.apnsKeyPath && config.apnsBundleId);
}

export function apnsEndpoint(environment: IosPushEnvironment = config.apnsEnvironment): string {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export type ApnsReadiness = 'ready' | 'unconfigured' | 'key-unreadable' | 'key-invalid';

/**
 * Where the signing key was read from, as a shape rather than a value.
 *
 * `ready` alone cannot distinguish a key on a Render Secret File mount from
 * one at a relative path that happens to resolve under the current working
 * directory. Those two fail differently: the mount survives a deploy, the
 * relative path is true until the next build changes what cwd contains, at
 * which point readiness silently becomes `key-unreadable` with nothing having
 * been edited. Blueprints cannot declare secret files, so this classification
 * is the only way the deployed process can report which one it actually got.
 */
export type ApnsKeySource = 'secret-file' | 'absolute-path' | 'relative-path' | 'unset';

export function classifyApnsKeyPath(keyPath: string): ApnsKeySource {
  if (!keyPath) return 'unset';
  if (keyPath.startsWith('/etc/secrets/')) return 'secret-file';
  return keyPath.startsWith('/') ? 'absolute-path' : 'relative-path';
}

/**
 * The signing key is read once and kept, so readiness is a property of this
 * process rather than of whatever the filesystem happened to look like when a
 * monitor last polled. Reading per token made the key's availability a runtime
 * fact sampled at an arbitrary moment; captured at boot it is a startup fact,
 * settled while a human is watching the deploy and unable to change underneath
 * a running process. The key material never leaves this module.
 */
let signingState: { readiness: ApnsReadiness; keySource: ApnsKeySource; privateKey: string | null } | null = null;

function capture(): { readiness: ApnsReadiness; keySource: ApnsKeySource; privateKey: string | null } {
  // Classified from the configured path, not from whether the read worked, so
  // the answer is the same whether or not the file is there.
  const keySource = classifyApnsKeyPath(config.apnsKeyPath);
  if (!isApnsConfigured()) return { readiness: 'unconfigured', keySource, privateKey: null };

  let privateKey: string;
  try {
    // Synchronous by design: boot is the one point where blocking is correct,
    // and it removes any window where /health could be served before the
    // capture resolved and report a state that is merely not-yet-known.
    privateKey = readFileSync(config.apnsKeyPath, 'utf8');
  } catch {
    return { readiness: 'key-unreadable', keySource, privateKey: null };
  }

  // Validated by signing once here rather than on first send, so a malformed
  // key is a boot-time verdict too.
  if (!signWith(privateKey)) return { readiness: 'key-invalid', keySource, privateKey: null };
  return { readiness: 'ready', keySource, privateKey };
}

/**
 * Reads the signing key once, at startup. Never throws and never exits: a
 * service that cannot announce anything must still serve everything else, the
 * same reason `push` is not part of the `healthy` test.
 */
export function captureApnsSigningState(): ApnsReadiness {
  signingState = capture();
  return signingState.readiness;
}

function currentState(): { readiness: ApnsReadiness; keySource: ApnsKeySource; privateKey: string | null } {
  // Callers that never boot the API (scripts, tests) still get capture-once
  // semantics rather than a probe per token.
  if (!signingState) signingState = capture();
  return signingState;
}

/**
 * Reports the state captured at boot. Deliberately synchronous and free of
 * I/O: a health poll must not be able to read the key or mint a token as a
 * side effect of being asked a question.
 */
export function apnsReadiness(): ApnsReadiness {
  return currentState().readiness;
}

/**
 * Reports which kind of path the key was configured with, captured alongside
 * readiness. A shape, never the path itself: the filename of a secret file is
 * not a secret, but it is also not something /health needs to publish.
 */
export function apnsKeySource(): ApnsKeySource {
  return currentState().keySource;
}

function signWith(privateKey: string): string | null {
  try {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64UrlJson({ alg: 'ES256', kid: config.apnsKeyId });
    const claims = base64UrlJson({ iss: config.apnsTeamId, iat: issuedAt });
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${header}.${claims}.${signature}`;
  } catch {
    return null;
  }
}

async function providerToken(): Promise<string | null> {
  const { privateKey } = currentState();
  if (!privateKey) return null;

  const now = Date.now();
  if (cachedProviderToken && cachedProviderToken.expiresAt > now) return cachedProviderToken.value;

  const value = signWith(privateKey);
  if (!value) return null;
  // APNs permits provider tokens for up to one hour. Refresh conservatively.
  cachedProviderToken = { value, expiresAt: now + (50 * 60 * 1000) };
  return value;
}

/** Test-only: re-runs the boot capture after a config change. */
export function recaptureApnsSigningStateForTests(): ApnsReadiness {
  cachedProviderToken = null;
  return captureApnsSigningState();
}

function isPermanentApnsFailure(status: number, reason: string | undefined): boolean {
  return status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic';
}

export async function sendApnsNotification(
  device: { token: string; environment: IosPushEnvironment },
  payload: ApnsPayload,
): Promise<ApnsSendStatus> {
  const authorization = await providerToken();
  if (!authorization) return 'skipped';

  return new Promise((resolve) => {
    let settled = false;
    let session: ClientHttp2Session | null = null;
    const finish = (status: ApnsSendStatus) => {
      if (settled) return;
      settled = true;
      session?.close();
      resolve(status);
    };

    try {
      const connection = connect(apnsEndpoint(device.environment));
      session = connection;
      connection.once('error', () => finish('temporary-failure'));

      const request = connection.request({
        ':method': 'POST',
        ':path': `/3/device/${device.token}`,
        authorization: `bearer ${authorization}`,
        'apns-topic': config.apnsBundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': '0',
        'content-type': 'application/json',
      });

      let statusCode = 0;
      let responseBody = '';
      request.setEncoding('utf8');
      request.setTimeout(10_000, () => {
        request.close();
        finish('temporary-failure');
      });
      request.once('response', (headers) => {
        statusCode = Number(headers[':status'] ?? 0);
      });
      request.on('data', (chunk: string) => {
        // APNs error bodies are tiny; cap retained data to avoid unbounded input.
        if (responseBody.length < 4096) responseBody += chunk.slice(0, 4096 - responseBody.length);
      });
      request.once('error', () => finish('temporary-failure'));
      request.once('end', () => {
        if (statusCode >= 200 && statusCode < 300) {
          finish('sent');
          return;
        }

        let reason: string | undefined;
        try {
          const parsed = JSON.parse(responseBody) as { reason?: unknown };
          reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
        } catch {
          // A malformed upstream error remains a temporary failure.
        }
        finish(isPermanentApnsFailure(statusCode, reason) ? 'permanent-failure' : 'temporary-failure');
      });
      request.end(JSON.stringify(payload));
    } catch {
      finish('temporary-failure');
    }
  });
}
