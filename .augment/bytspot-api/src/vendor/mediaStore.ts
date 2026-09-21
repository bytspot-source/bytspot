import { randomUUID } from 'crypto';
import { captureError } from '../lib/observability';
import { objectStore, type ObjectHead, type PresignedRequest } from '../lib/objectStore';
import { MEDIA_PRESIGN_TTL_SECONDS, type MediaKind, type MediaParent } from './media';

export function objectStoreConfigured(): boolean {
  return objectStore().configured();
}

export function vendorObjectKey(input: {
  sellerId: string;
  parent: MediaParent;
  parentId: string;
  kind: MediaKind;
  mediaId: string;
}): string {
  return `vendor/${input.sellerId}/${input.parent}/${input.parentId}/${input.kind}/${input.mediaId}`;
}

export async function writeVendorObject(input: {
  key: string;
  bytes: Buffer;
  mimeType: string;
}): Promise<void> {
  await objectStore().put(input);
}

export async function readVendorObject(storageKey: string | null | undefined): Promise<Buffer | null> {
  if (!storageKey) return null;
  return objectStore().get(storageKey);
}

export async function deleteVendorObject(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey) return;
  try {
    await objectStore().delete(storageKey);
  } catch (err) {
    captureError(err, { route: 'vendor/media:object-delete' });
  }
}

export async function headVendorObject(storageKey: string): Promise<ObjectHead | null> {
  return objectStore().head(storageKey);
}

export function presignVendorPut(input: { key: string; mimeType: string; now?: Date }): PresignedRequest {
  return objectStore().presignPut({
    key: input.key,
    mimeType: input.mimeType,
    expiresInSeconds: MEDIA_PRESIGN_TTL_SECONDS,
    now: input.now,
  });
}

export function presignVendorGet(input: { key: string; now?: Date }): PresignedRequest {
  return objectStore().presignGet({
    key: input.key,
    expiresInSeconds: MEDIA_PRESIGN_TTL_SECONDS,
    now: input.now,
  });
}

export function nextMediaId(): string {
  return randomUUID();
}

export function bytesFromRow(bytes: Uint8Array | Buffer | null | undefined): Buffer | null {
  if (!bytes || bytes.length === 0) return null;
  return Buffer.from(bytes);
}
