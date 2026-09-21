import { createHash, createHmac } from 'crypto';
import { config } from '../config';

/**
 * S3-compatible object store (R2, S3, MinIO). Unset credentials mean the
 * media routes keep writing Postgres bytes and video stays closed.
 *
 * Routes never import fetch or signing. Tests substitute `objectStoreHandle`.
 */
export interface ObjectStore {
  configured(): boolean;
  put(object: { key: string; bytes: Buffer; mimeType: string }): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const EMPTY = {
  configured: () => false,
  put: async () => {
    throw new Error('object store is not configured');
  },
  get: async () => null,
  delete: async () => undefined,
} satisfies ObjectStore;

export function memoryObjectStore(): ObjectStore {
  const objects = new Map<string, Buffer>();
  return {
    configured: () => true,
    put: async ({ key, bytes }) => {
      objects.set(key, Buffer.from(bytes));
    },
    get: async (key) => {
      const found = objects.get(key);
      return found ? Buffer.from(found) : null;
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** AWS SigV4 URI encode: unreserved stay, slash is a delimiter when `path` is true. */
export function awsEncode(value: string, path = false): string {
  let encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  if (path) encoded = encoded.replace(/%2F/g, '/');
  return encoded;
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

export interface S3StoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
}

function objectUrl(options: S3StoreOptions, key: string): { url: URL; host: string; canonicalUri: string } {
  const encodedKey = awsEncode(key, true);
  if (options.endpoint) {
    const base = new URL(options.endpoint);
    const canonicalUri = `/${awsEncode(options.bucket, true)}/${encodedKey}`;
    return { url: new URL(canonicalUri, base), host: new URL(base).host, canonicalUri };
  }
  const host = `${options.bucket}.s3.${options.region}.amazonaws.com`;
  return { url: new URL(`https://${host}/${encodedKey}`), host, canonicalUri: `/${encodedKey}` };
}

export function s3CompatibleStore(options: S3StoreOptions): ObjectStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const region = options.region || 'auto';

  async function signed(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, mimeType?: string): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const { url, host, canonicalUri } = objectUrl(options, key);

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (mimeType && method === 'PUT') headers['content-type'] = mimeType;

    const signedHeaderNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(options.secretAccessKey, dateStamp, region), stringToSign).toString('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'host' || name === 'content-length') continue;
      requestHeaders.set(name, value);
    }

    return fetchImpl(url, {
      method,
      headers: requestHeaders,
      body: method === 'PUT' ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  }

  return {
    configured: () => true,
    put: async ({ key, bytes, mimeType }) => {
      const response = await signed('PUT', key, bytes, mimeType);
      if (!response.ok) {
        throw new Error(`object store put failed (${response.status})`);
      }
    },
    get: async (key) => {
      const response = await signed('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`object store get failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },
    delete: async (key) => {
      const response = await signed('DELETE', key);
      if (response.status === 404 || response.ok) return;
      throw new Error(`object store delete failed (${response.status})`);
    },
  };
}

function fromConfig(): ObjectStore {
  const { mediaS3Bucket, mediaS3AccessKeyId, mediaS3SecretAccessKey, mediaS3Endpoint, mediaS3Region } = config;
  if (!mediaS3Bucket || !mediaS3AccessKeyId || !mediaS3SecretAccessKey) return EMPTY;
  return s3CompatibleStore({
    endpoint: mediaS3Endpoint,
    region: mediaS3Region,
    bucket: mediaS3Bucket,
    accessKeyId: mediaS3AccessKeyId,
    secretAccessKey: mediaS3SecretAccessKey,
  });
}

/**
 * Indirection so tests can substitute a store, same pattern as redisHandle.
 */
export const objectStoreHandle = {
  get: (): ObjectStore => fromConfig(),
};

export function objectStore(): ObjectStore {
  return objectStoreHandle.get();
}
