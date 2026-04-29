import { Embeddings, type EmbeddingsParams } from '@langchain/core/embeddings';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { logger } from './logger.js';

export interface HuggingFaceTransformersEmbeddingsParams extends EmbeddingsParams {
  model?: string;
  batchSize?: number;
}

/**
 * LangChain Embeddings backed by `@huggingface/transformers` (Transformers.js).
 *
 * Uses `Xenova/all-MiniLM-L6-v2` by default — the same model the Python service
 * uses (`sentence-transformers/all-MiniLM-L6-v2`). Output is mean-pooled and
 * L2-normalized, producing 384-dim vectors numerically equivalent to the
 * Python sentence-transformers output. This means the existing Pinecone
 * `hallha` index is reusable across both runtimes.
 *
 * The model is downloaded once on first use (~90MB) and cached locally.
 */
export class HuggingFaceTransformersEmbeddings extends Embeddings {
  readonly model: string;
  readonly batchSize: number;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(params: HuggingFaceTransformersEmbeddingsParams = {}) {
    super(params);
    this.model = params.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.batchSize = params.batchSize ?? 32;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      logger.info({ model: this.model }, 'Loading embedding pipeline (first run downloads weights)');
      this.pipelinePromise = pipeline('feature-extraction', this.model);
    }
    return this.pipelinePromise;
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (documents.length === 0) return [];
    const extractor = await this.getPipeline();
    const out: number[][] = [];

    for (let i = 0; i < documents.length; i += this.batchSize) {
      const batch = documents.slice(i, i + this.batchSize);
      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
      const dims = tensor.dims;
      const raw = tensor.tolist() as unknown;
      let rows: number[][];
      if (dims.length === 1) {
        rows = [raw as number[]];
      } else {
        rows = raw as number[][];
      }
      if (rows.length !== batch.length) {
        throw new Error(
          `Embedding batch size mismatch: got ${rows.length} vectors for ${batch.length} texts (dims=${JSON.stringify(dims)})`,
        );
      }
      out.push(...rows);
    }
    return out;
  }

  async embedQuery(document: string): Promise<number[]> {
    const extractor = await this.getPipeline();
    const tensor = await extractor(document, { pooling: 'mean', normalize: true });
    const dims = tensor.dims;
    if (dims.length === 1) {
      return tensor.tolist() as number[];
    }
    const list = tensor.tolist() as number[][];
    if (!list[0]) {
      throw new Error('Embedding pipeline returned no vector');
    }
    return list[0];
  }
}

let singleton: HuggingFaceTransformersEmbeddings | null = null;

export function getEmbeddings(): HuggingFaceTransformersEmbeddings {
  if (!singleton) {
    singleton = new HuggingFaceTransformersEmbeddings();
  }
  return singleton;
}
