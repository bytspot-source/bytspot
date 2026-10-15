import { TRPCError } from '@trpc/server';

const maxMediaBytes = 600_000;
const maxMediaPixels = 4_096;

export function parseImageDataUri(dataUri: string, label = 'Party media'): { bytes: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri);
  if (!match) throw new TRPCError({ code: 'BAD_REQUEST', message: `${label} must be a JPEG, PNG, or WebP data URI.` });
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxMediaBytes) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: `${label} must be no larger than 600 KB.` });
  }
  if (bytes.toString('base64') !== match[2] || !hasImageSignature(bytes, match[1])) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${label} bytes do not match the declared image type.` });
  }
  // The byte ceiling alone let a 3840x2160 cover through, because a heavily
  // compressed 4K frame still fits in 600 KB. Clients target 1600px; this is a
  // generous backstop so the invariant does not depend on the client alone.
  const dimensions = imageDimensions(bytes, match[1]);
  if (dimensions && Math.max(dimensions.width, dimensions.height) > maxMediaPixels) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${label} must be no larger than ${maxMediaPixels}px on its long edge.` });
  }
  return { bytes, mimeType: match[1] };
}

/**
 * Reads intrinsic dimensions from an image header. Returns null when the format
 * is one we cannot measure cheaply (animated or extended WebP), in which case
 * the byte ceiling remains the only limit rather than rejecting a valid upload.
 */
function imageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png') {
    return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  }
  if (mimeType === 'image/jpeg') {
    // Walk the segment chain to the frame header; SOF0-SOF15 carry the size,
    // excluding the four marker codes that are not frame headers.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return null;
  }
  // Lossy and lossless WebP keep the size in the first chunk; VP8X does not.
  const chunk = bytes.length >= 16 ? bytes.toString('ascii', 12, 16) : '';
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const header = bytes.readUInt32LE(21);
    return { width: (header & 0x3fff) + 1, height: ((header >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
