import { randomUUID } from 'node:crypto';
import { getEmbeddings } from '../lib/embeddings.js';
import { getPineconeClient } from '../lib/pinecone.js';
import { extractPdfMarkdown } from '../utils/pdf-to-markdown.js';
import { splitMarkdownByHeadings } from '../utils/markdown-header-splitter.js';
import { extractStandardNumber } from '../utils/standard-number.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

export type IngestExtraMetadata = Record<string, string | number>;

export type IngestInput = {
  buffer: Buffer;
  originalName: string;
  s3Key: string;
  s3Url: string;
  /** Pinecone namespace to upsert into. e.g. GLOBAL_AAOIFI_NAMESPACE or clientTenantNamespace(clientId). */
  namespace: string;
  /** Extra metadata attached to every chunk (firmId, clientId, scope, documentType, ...). */
  extraMetadata?: IngestExtraMetadata;
};

export async function ingestPdfToPinecone(input: IngestInput): Promise<string> {
  const { buffer, originalName, s3Key, s3Url, namespace, extraMetadata = {} } = input;

  if (!buffer || buffer.length === 0) {
    throw new IngestError('Uploaded file is empty.');
  }

  const source = originalName;

  let markdown: string;
  let pageCount: number;
  try {
    const extracted = await extractPdfMarkdown(new Uint8Array(buffer));
    markdown = extracted.markdown;
    pageCount = extracted.pageCount;
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(
      'Could not read PDF. The file may be corrupted, truncated, or not a real PDF — ' +
        'try re-exporting it or uploading again.',
    );
  }

  const chunks = await splitMarkdownByHeadings(markdown, {
    source,
    s3Key,
    s3Url,
  });

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
  const ns = pineconeIndex.namespace(namespace);

  logger.info(
    { source, pageCount, chunkCount: usable.length, s3Key, namespace },
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
        headings?: string;
        standard_number?: string;
      };
      const headingsStr = meta.headings ?? '';
      const sourceStr = meta.source ?? source;
      const stdRaw =
        typeof meta.standard_number === 'string' && meta.standard_number.trim()
          ? meta.standard_number.trim()
          : extractStandardNumber(headingsStr, sourceStr);
      return {
        id: randomUUID(),
        values,
        metadata: {
          source: sourceStr,
          page: meta.page ?? 0,
          s3Key: meta.s3Key ?? s3Key,
          s3Url: meta.s3Url ?? s3Url,
          headings: headingsStr,
          standard_number: stdRaw ?? '',
          ...extraMetadata,
          [textKey]: doc.pageContent,
        },
      };
    });
    await ns.upsert({ records });
  }

  return `Successfully uploaded ${usable.length} document chunks to Pinecone.`;
}
