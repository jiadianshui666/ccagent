import {
  buildSemanticIndex,
  formatSemanticIndexBuild,
  formatSemanticIndexSearch,
  formatSemanticIndexStatus,
  getSemanticIndexStatus,
  searchSemanticIndex,
} from "../semanticIndex.js";
import { loadConfig } from "../config.js";
import { createOpenAIEmbeddingProvider } from "../embeddingProvider.js";
import { getOpenAIBaseURLFromEnv } from "../model.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export class BuildSemanticIndexTool implements Tool {
  readonly name = "build_semantic_index";
  readonly description = "Build or refresh the semantic vector index under .ccagent/index.";
  readonly parameters = {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (Object.keys(input).length > 0) {
      return {
        ok: false,
        error: "build_semantic_index does not accept input parameters.",
      };
    }

    const provider = await resolveEmbeddingProvider(context.workspaceRoot);
    const result = await buildSemanticIndex(context.workspaceRoot, {
      ...(provider ? { provider } : {}),
    });

    return {
      ok: true,
      content: formatSemanticIndexBuild(result),
      metadata: {
        bytesIndexed: result.index.stats.bytesIndexed,
        cacheStatus: result.index.stats.cacheStatus,
        chunksIndexed: result.index.stats.chunksIndexed,
        chunksRebuilt: result.index.stats.chunksRebuilt,
        chunksReused: result.index.stats.chunksReused,
        dimensions: result.index.dimensions,
        filesIndexed: result.index.stats.filesIndexed,
        filesRebuilt: result.index.stats.filesRebuilt,
        filesScanned: result.index.stats.filesScanned,
        filesReused: result.index.stats.filesReused,
        model: result.index.model,
        path: result.path,
        provider: result.index.provider,
        truncated: result.index.stats.truncated,
      },
    };
  }
}

export class SemanticIndexStatusTool implements Tool {
  readonly name = "semantic_index_status";
  readonly description = "Show whether the semantic vector index exists and when it was built.";
  readonly parameters = {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (Object.keys(input).length > 0) {
      return {
        ok: false,
        error: "semantic_index_status does not accept input parameters.",
      };
    }

    const status = await getSemanticIndexStatus(context.workspaceRoot);

    return {
      ok: true,
      content: formatSemanticIndexStatus(status),
      metadata: status.exists
        ? {
            dimensions: status.index.dimensions,
            exists: true,
            chunksIndexed: status.index.stats.chunksIndexed,
            chunksRebuilt: status.index.stats.chunksRebuilt,
            chunksReused: status.index.stats.chunksReused,
            cacheStatus: status.index.stats.cacheStatus,
            filesIndexed: status.index.stats.filesIndexed,
            filesRebuilt: status.index.stats.filesRebuilt,
            filesReused: status.index.stats.filesReused,
            model: status.index.model,
            path: status.path,
          }
        : {
            exists: false,
            path: status.path,
          },
    };
  }
}

export class SearchSemanticIndexTool implements Tool {
  readonly name = "search_semantic_index";
  readonly description = "Search the semantic vector index for conceptually related file chunks.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Task, feature, symbol, or error text to search in the semantic vector index.",
      },
      limit: {
        type: "number",
        description: "Maximum number of semantic file matches to show, from 1 to 25.",
      },
    },
    required: ["query", "limit"],
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (typeof input.query !== "string") {
      return {
        ok: false,
        error: "Expected input.query to be a string.",
      };
    }

    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      return {
        ok: false,
        error: "Expected input.limit to be a number.",
      };
    }

    const provider = await resolveEmbeddingProvider(context.workspaceRoot);
    const search = await searchSemanticIndex(
      context.workspaceRoot,
      input.query,
      input.limit,
      {
        ...(provider ? { provider } : {}),
      },
    );

    return {
      ok: true,
      content: formatSemanticIndexSearch(search, input.query.trim()),
      metadata: {
        count: search?.results.length ?? 0,
        dimensions: search?.index.dimensions,
        indexed: Boolean(search),
        model: search?.index.model,
        provider: search?.index.provider,
        query: input.query.trim(),
      },
    };
  }
}

async function resolveEmbeddingProvider(workspaceRoot: string) {
  const loaded = await loadConfig(workspaceRoot);
  const model = process.env.CCAGENT_EMBEDDING_MODEL?.trim() || loaded.config.openai?.embeddingModel?.trim();
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!model || !apiKey) {
    return undefined;
  }

  return createOpenAIEmbeddingProvider({
    apiKey,
    baseURL: getOpenAIBaseURLFromEnv(loaded.config.openai?.baseURL),
    model,
    retry: loaded.config.openai?.retry,
  });
}
