import {
  buildContextIndex,
  formatContextIndexBuild,
  formatContextIndexSearch,
  formatContextIndexStatus,
  getContextIndexStatus,
  searchContextIndex,
} from "../contextIndex.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export class BuildContextIndexTool implements Tool {
  readonly name = "build_context_index";
  readonly description = "Build or refresh the persistent local context index under .ccagent/index.";
  readonly parameters = {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (Object.keys(input).length > 0) {
      return {
        ok: false,
        error: "build_context_index does not accept input parameters.",
      };
    }

    const result = await buildContextIndex(context.workspaceRoot);

    return {
      ok: true,
      content: formatContextIndexBuild(result),
      metadata: {
        bytesIndexed: result.index.stats.bytesIndexed,
        cacheStatus: result.index.stats.cacheStatus,
        filesIndexed: result.index.stats.filesIndexed,
        filesRebuilt: result.index.stats.filesRebuilt,
        filesScanned: result.index.stats.filesScanned,
        filesReused: result.index.stats.filesReused,
        moduleEdges: result.index.stats.moduleEdges,
        symbolEdges: result.index.stats.symbolEdges,
        symbols: result.index.stats.symbols,
        path: result.path,
        truncated: result.index.stats.truncated,
      },
    };
  }
}

export class ContextIndexStatusTool implements Tool {
  readonly name = "context_index_status";
  readonly description = "Show whether the persistent local context index exists and when it was built.";
  readonly parameters = {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const;

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (Object.keys(input).length > 0) {
      return {
        ok: false,
        error: "context_index_status does not accept input parameters.",
      };
    }

    const status = await getContextIndexStatus(context.workspaceRoot);

    return {
      ok: true,
      content: formatContextIndexStatus(status),
      metadata: status.exists
        ? {
          cacheStatus: status.index.stats.cacheStatus,
          exists: true,
          filesIndexed: status.index.stats.filesIndexed,
          filesRebuilt: status.index.stats.filesRebuilt,
          filesReused: status.index.stats.filesReused,
          moduleEdges: status.index.stats.moduleEdges,
          symbolEdges: status.index.stats.symbolEdges,
          symbols: status.index.stats.symbols,
          path: status.path,
        }
        : {
            exists: false,
            path: status.path,
          },
    };
  }
}

export class SearchContextIndexTool implements Tool {
  readonly name = "search_context_index";
  readonly description = "Search the persistent local context index for relevant files and snippets.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Task, feature, symbol, or error text to search in the context index.",
      },
      limit: {
        type: "number",
        description: "Maximum number of indexed file matches to show, from 1 to 25.",
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

    const search = await searchContextIndex(context.workspaceRoot, input.query, input.limit);

    return {
      ok: true,
      content: formatContextIndexSearch(search, input.query.trim()),
      metadata: {
        count: search?.results.length ?? 0,
        graphExpanded: search?.graphExpanded ?? 0,
        graphMaxDepth: search?.graphMaxDepth ?? 0,
        graphRelations: search?.graphRelations ?? 0,
        indexed: Boolean(search),
        symbols: search?.index.stats.symbols ?? 0,
        query: input.query.trim(),
      },
    };
  }
}
