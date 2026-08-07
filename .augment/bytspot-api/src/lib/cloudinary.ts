import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config';

export async function uploadPartyImage(dataUri: string, publicId: string): Promise<string> {
  if (!config.cloudinaryUrl) throw new Error('Cloudinary media storage is not configured.');
  cloudinary.config({ secure: true });
  const result = await cloudinary.uploader.upload(dataUri, {
    public_id: publicId,
    overwrite: true,
    invalidate: true,
    resource_type: 'image',
    transformation: [{ width: 1800, height: 1800, crop: 'limit', quality: 'auto:good' }],
  });
  const url = new URL(result.secure_url);
  if (url.protocol !== 'https:') throw new Error('Cloudinary did not return a secure media URL.');
  return url.toString();
}