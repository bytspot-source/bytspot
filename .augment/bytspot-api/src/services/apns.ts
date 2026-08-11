import { connect, type ClientHttp2Session } from 'node:http2';
import { readFile } from 'node:fs/promises';
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

async function providerToken(): Promise<string | null> {
  if (!isApnsConfigured()) return null;

  const now = Date.now();
  if (cachedProviderToken && cachedProviderToken.expiresAt > now) {
    return cachedProviderToken.value;
  }

  try {
    const privateKey = await readFile(config.apnsKeyPath, 'utf8');
    const issuedAt = Math.floor(now / 1000);
    const header = base64UrlJson({ alg: 'ES256', kid: config.apnsKeyId });
    const claims = base64UrlJson({ iss: config.apnsTeamId, iat: issuedAt });
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const value = `${header}.${claims}.${signature}`;

    // APNs permits provider tokens for up to one hour. Refresh conservatively.
    cachedProviderToken = { value, expiresAt: now + (50 * 60 * 1000) };
    return value;
  } catch {
    return null;
  }
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
