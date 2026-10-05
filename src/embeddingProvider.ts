import OpenAI from "openai";
import {
  buildOpenAIClientConfig,
  runWithProviderRetries,
  type ModelProviderRetryConfig,
} from "./model.js";

export type EmbeddingProviderSource = "openai";

export type EmbeddingProvider = {
  readonly baseURL?: string;
  readonly model: string;
  readonly source: EmbeddingProviderSource;
  embedTexts(texts: string[]): Promise<number[][]>;
};

export type OpenAIEmbeddingProviderOptions = {
  apiKey: string;
  baseURL?: string;
  model: string;
  retry?: ModelProviderRetryConfig;
};

export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingProviderOptions,
): EmbeddingProvider {
  const client = new OpenAI(buildOpenAIClientConfig(options.apiKey, options.baseURL));

  return {
    baseURL: options.baseURL,
    model: options.model,
    source: "openai",
    async embedTexts(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }

      const response = await runWithProviderRetries(
        () => client.embeddings.create({
          encoding_format: "float",
          input: texts,
          model: options.model,
        }),
        options.retry,
      );
      const vectorsByIndex = new Map<number, number[]>();

      for (const item of response.data) {
        vectorsByIndex.set(item.index, normalizeProviderVector(item.embedding));
      }

      return texts.map((_, index) => {
        const vector = vectorsByIndex.get(index);

        if (!vector) {
          throw new Error(`Embedding provider did not return vector index ${index}.`);
        }

        return vector;
      });
    },
  };
}

function normalizeProviderVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("Embedding provider returned an empty vector.");
  }

  const normalized = vector.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Embedding provider returned a non-numeric vector value.");
    }

    return value;
  });
  const norm = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));

  if (norm === 0) {
    return normalized;
  }

  return normalized.map((value) => Number((value / norm).toFixed(6)));
}
