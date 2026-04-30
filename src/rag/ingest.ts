import { randomUUID } from 'node:crypto';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEmbeddings } from '../lib/embeddings.js';
import { getPineconeClient } from '../lib/pinecone.js';
import { extractPdfText } from '../utils/pdf.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

export type IngestInput = {
  buffer: Buffer;
  originalName: string;
  s3Key: string;
  s3Url: string;
  organizationId: string;
};

export async function ingestPdfToPinecone(input: IngestInput): Promise<string> {
  const { buffer, originalName, s3Key, s3Url, organizationId } = input;

  if (!buffer || buffer.length === 0) {
    throw new IngestError('Uploaded file is empty.');
  }

  let pages: string[];
  try {
    const extracted = await extractPdfText(new Uint8Array(buffer));
    pages = extracted.pages;
  } catch {
    throw new IngestError(
      'Could not read PDF. The file may be corrupted, truncated, or not a real PDF — ' +
        'try re-exporting it or uploading again.',
    );
  }

  const source = originalName;
  const docs = pages.map(
    (pageContent, i) =>
      new Document({
        pageContent,
        metadata: { source, page: i + 1, s3Key, s3Url, organizationId },
      }),
  );

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1800,
    chunkOverlap: 150,
  });
  const chunks = await splitter.splitDocuments(docs);

  const usable = chunks.filter((c) => c.pageContent.trim().length > 0);
  if (usable.length === 0) {
    throw new IngestError('No indexable text was found in the PDF after splitting.');
  }
  if (usable.length < chunks.length) {
    logger.warn(
      { dropped: chunks.length - usable.length },
      'Skipped empty text chunks before indexing',
    );
  }

  const pineconeIndex = getPineconeClient().Index(env.PINECONE_INDEX);
  const namespace = pineconeIndex.namespace('');

  logger.info(
    { source, pageCount: pages.length, chunkCount: usable.length, s3Key },
    'Ingesting PDF chunks',
  );

  const embeddings = getEmbeddings();
  const vectors = await embeddings.embedDocuments(usable.map((c) => c.pageContent));
  if (vectors.length !== usable.length) {
    throw new IngestError('Embedding pipeline returned fewer vectors than text chunks.');
  }

  const textKey = 'text';
  const UPSERT_BATCH = 100;
  for (let i = 0; i < usable.length; i += UPSERT_BATCH) {
    const docBatch = usable.slice(i, i + UPSERT_BATCH);
    const vecBatch = vectors.slice(i, i + UPSERT_BATCH);
    const records = docBatch.map((doc, j) => {
      const values = vecBatch[j];
      if (!values?.length) {
        throw new IngestError('Missing embedding vector for a text chunk.');
      }
      const meta = doc.metadata as {
        source?: string;
        page?: number;
        s3Key?: string;
        s3Url?: string;
        organizationId?: string;
      };
      return {
        id: randomUUID(),
        values,
        metadata: {
          source: meta.source ?? source,
          page: meta.page ?? 0,
          s3Key: meta.s3Key ?? s3Key,
          s3Url: meta.s3Url ?? s3Url,
          organizationId: meta.organizationId ?? organizationId,
          [textKey]: doc.pageContent,
        },
      };
    });
    await namespace.upsert({ records });
  }

  return `Successfully uploaded ${usable.length} document chunks to Pinecone.`;
}
