import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

let s3Client: S3Client | null = null;

const PRESIGN_EXPIRES_SECONDS = 60 * 60 * 24 * 7;

export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
}

function buildPublicUrl(key: string): string | null {
  const base = env.AWS_S3_BUCKET_URL?.trim();
  if (!base) return null;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${encodeURI(key)}`;
}

export async function putKnowledgeObject(
  buffer: Buffer,
  originalName: string,
  contentType: string | undefined,
  organizationId: string,
): Promise<{ key: string; url: string }> {
  const safe = sanitizeFileName(originalName);
  const key = `knowledge/${organizationId}/${randomUUID()}-${safe}`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType ?? 'application/octet-stream',
    }),
  );

  const url = buildPublicUrl(key) ?? (await getKnowledgeObjectUrl(key));
  return { key, url };
}

export async function getKnowledgeObjectUrl(key: string): Promise<string> {
  const publicUrl = buildPublicUrl(key);
  if (publicUrl) return publicUrl;

  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }),
    { expiresIn: PRESIGN_EXPIRES_SECONDS },
  );
}
