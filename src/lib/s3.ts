import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import type { ClientDocumentType } from './client-schema.js';
import { HttpError } from '../middleware/error.js';

export const GLOBAL_AAOIFI_S3_PREFIX = 'uploads/global/aaoifi/';

export function clientS3Prefix(firmId: string, clientId: string): string {
  return `uploads/firms/${firmId}/clients/${clientId}/`;
}

export function clientS3PrefixForType(
  firmId: string,
  clientId: string,
  documentType: ClientDocumentType,
): string {
  return `${clientS3Prefix(firmId, clientId)}${documentType}/`;
}

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

/** Leading UUID + hyphen from keys like `knowledge/orgId/<uuid>-filename.pdf`. */
const OBJECT_KEY_UUID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i;

export function displayNameFromObjectKey(key: string): string {
  const base = key.split('/').pop() ?? key;
  const stripped = base.replace(OBJECT_KEY_UUID_PREFIX, '');
  return stripped.length > 0 ? stripped : base;
}

const KNOWLEDGE_LIST_MAX_KEYS_CAP = 100;

export type KnowledgeListObject = {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  url: string;
};

export async function listKnowledgeObjects(
  organizationId: string,
  opts?: { maxKeys?: number; continuationToken?: string },
): Promise<{ items: KnowledgeListObject[]; nextContinuationToken: string | null }> {
  const maxKeys = Math.min(opts?.maxKeys ?? KNOWLEDGE_LIST_MAX_KEYS_CAP, KNOWLEDGE_LIST_MAX_KEYS_CAP);
  const out = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Prefix: `knowledge/${organizationId}/`,
      MaxKeys: maxKeys,
      ContinuationToken: opts?.continuationToken,
    }),
  );

  const contents = out.Contents ?? [];
  const items: KnowledgeListObject[] = await Promise.all(
    contents
      .filter((c): c is typeof c & { Key: string } => typeof c.Key === 'string' && c.Key.length > 0)
      .map(async (c) => {
        const key = c.Key;
        const url = buildPublicUrl(key) ?? (await getKnowledgeObjectUrl(key));
        return {
          key,
          name: displayNameFromObjectKey(key),
          size: c.Size ?? 0,
          lastModified: c.LastModified?.toISOString() ?? new Date(0).toISOString(),
          url,
        };
      }),
  );

  items.sort((a, b) => b.lastModified.localeCompare(a.lastModified));

  const nextContinuationToken = out.IsTruncated && out.NextContinuationToken
    ? out.NextContinuationToken
    : null;

  return { items, nextContinuationToken };
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

export async function deleteKnowledgeObject(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }),
  );
}

export async function listGlobalAaoifiObjects(opts?: {
  maxKeys?: number;
  continuationToken?: string;
}): Promise<{ items: KnowledgeListObject[]; nextContinuationToken: string | null }> {
  const maxKeys = Math.min(opts?.maxKeys ?? KNOWLEDGE_LIST_MAX_KEYS_CAP, KNOWLEDGE_LIST_MAX_KEYS_CAP);
  const out = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Prefix: GLOBAL_AAOIFI_S3_PREFIX,
      MaxKeys: maxKeys,
      ContinuationToken: opts?.continuationToken,
    }),
  );
  const contents = out.Contents ?? [];
  const items: KnowledgeListObject[] = await Promise.all(
    contents
      .filter((c): c is typeof c & { Key: string } => typeof c.Key === 'string' && c.Key.length > 0)
      .map(async (c) => {
        const key = c.Key;
        const url = buildPublicUrl(key) ?? (await getKnowledgeObjectUrl(key));
        return {
          key,
          name: displayNameFromObjectKey(key),
          size: c.Size ?? 0,
          lastModified: c.LastModified?.toISOString() ?? new Date(0).toISOString(),
          url,
        };
      }),
  );
  items.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  const nextContinuationToken =
    out.IsTruncated && out.NextContinuationToken ? out.NextContinuationToken : null;
  return { items, nextContinuationToken };
}

export async function putGlobalAaoifiObject(
  buffer: Buffer,
  originalName: string,
  contentType: string | undefined,
): Promise<{ key: string; url: string }> {
  const safe = sanitizeFileName(originalName);
  const key = `${GLOBAL_AAOIFI_S3_PREFIX}${randomUUID()}-${safe}`;
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

export type ClientS3ListItem = {
  key: string;
  name: string;
  documentType: ClientDocumentType | null;
  size: number;
  lastModified: string;
  url: string;
};

function documentTypeFromKey(
  key: string,
  firmId: string,
  clientId: string,
): ClientDocumentType | null {
  const prefix = clientS3Prefix(firmId, clientId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const candidate = rest.slice(0, slash) as ClientDocumentType;
  return candidate === 'policies' ||
    candidate === 'contracts' ||
    candidate === 'financials' ||
    candidate === 'other'
    ? candidate
    : null;
}

export async function putClientObject(
  buffer: Buffer,
  originalName: string,
  contentType: string | undefined,
  firmId: string,
  clientId: string,
  documentType: ClientDocumentType,
): Promise<{ key: string; url: string }> {
  const safe = sanitizeFileName(originalName);
  const key = `${clientS3PrefixForType(firmId, clientId, documentType)}${randomUUID()}-${safe}`;
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

export async function listClientObjects(
  firmId: string,
  clientId: string,
  opts?: {
    documentType?: ClientDocumentType;
    maxKeys?: number;
    continuationToken?: string;
  },
): Promise<{ items: ClientS3ListItem[]; nextContinuationToken: string | null }> {
  const maxKeys = Math.min(opts?.maxKeys ?? KNOWLEDGE_LIST_MAX_KEYS_CAP, KNOWLEDGE_LIST_MAX_KEYS_CAP);
  const prefix = opts?.documentType
    ? clientS3PrefixForType(firmId, clientId, opts.documentType)
    : clientS3Prefix(firmId, clientId);
  const out = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: maxKeys,
      ContinuationToken: opts?.continuationToken,
    }),
  );
  const contents = out.Contents ?? [];
  const items: ClientS3ListItem[] = await Promise.all(
    contents
      .filter((c): c is typeof c & { Key: string } => typeof c.Key === 'string' && c.Key.length > 0)
      .map(async (c) => {
        const key = c.Key;
        const url = buildPublicUrl(key) ?? (await getKnowledgeObjectUrl(key));
        return {
          key,
          name: displayNameFromObjectKey(key),
          documentType: documentTypeFromKey(key, firmId, clientId),
          size: c.Size ?? 0,
          lastModified: c.LastModified?.toISOString() ?? new Date(0).toISOString(),
          url,
        };
      }),
  );
  items.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  const nextContinuationToken =
    out.IsTruncated && out.NextContinuationToken ? out.NextContinuationToken : null;
  return { items, nextContinuationToken };
}

/**
 * Deletes a client object after verifying the key actually belongs to (firmId, clientId).
 * This is a defense-in-depth check on top of the route's ownership guard.
 */
export async function deleteClientObject(
  key: string,
  firmId: string,
  clientId: string,
): Promise<void> {
  const prefix = clientS3Prefix(firmId, clientId);
  if (!key.startsWith(prefix) || key.length <= prefix.length || key.includes('..')) {
    throw new HttpError(403, 'Object key does not belong to this client.');
  }
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }),
  );
}
