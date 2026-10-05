export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type WebFetchOptions = {
  fetcher?: Fetcher;
  maxChars?: number;
  timeoutMs?: number;
};

export type WebFetchResult = {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
};

export type WebSearchOptions = {
  baseUrl?: string;
  fetcher?: Fetcher;
  maxResults?: number;
  timeoutMs?: number;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_SEARCH_BASE_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_USER_AGENT = "CCAgent/0.3 (+terminal coding agent; https://github.com/ccagent)";

function defaultFetcher(timeoutMs: number): Fetcher {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: init?.signal ?? controller.signal,
        headers: init?.headers,
      });

      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function fetchWebPage(url: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  assertHttpUrl(url);
  const fetcher = options.fetcher ?? defaultFetcher(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const response = await fetcher(url, { headers: { "user-agent": DEFAULT_USER_AGENT } });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  const html = await response.text();
  const title = extractPageTitle(html);
  const { text, truncated } = htmlToPlainText(html, maxChars);

  if (text.length === 0) {
    throw new Error("Fetched page contained no readable text.");
  }

  return {
    url,
    ...(title ? { title } : {}),
    text,
    truncated,
  };
}

export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
  if (query.trim().length === 0) {
    throw new Error("Search query must be a non-empty string.");
  }

  const fetcher = options.fetcher ?? defaultFetcher(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const baseUrl = options.baseUrl ?? DEFAULT_SEARCH_BASE_URL;
  const maxResults = options.maxResults ?? DEFAULT_SEARCH_RESULTS;

  const url = `${baseUrl}?q=${encodeURIComponent(query.trim())}`;
  const response = await fetcher(url, { headers: { "user-agent": DEFAULT_USER_AGENT } });

  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}.`);
  }

  return parseDdgResults(await response.text(), maxResults);
}

export function htmlToPlainText(html: string, maxChars: number): { text: string; truncated: boolean } {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = htmlDecode(stripTags(withoutNoise)).replace(/\s+/g, " ").trim();
  const truncated = text.length > maxChars;

  return {
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
  };
}

export function extractPageTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (!match) {
    return undefined;
  }

  const title = htmlDecode(stripTags(match[1] ?? "")).replace(/\s+/g, " ").trim();

  return title.length > 0 ? title : undefined;
}

function parseDdgResults(html: string, maxResults: number): WebSearchResult[] {
  const links = extractDdgLinks(html);
  const snippets = extractDdgSnippets(html);
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (let index = 0; index < links.length && results.length < maxResults; index += 1) {
    const link = links[index];

    if (!link || !link.url || seenUrls.has(link.url)) {
      continue;
    }

    seenUrls.add(link.url);
    results.push({
      title: link.title || link.url,
      url: link.url,
      snippet: snippets[index] ?? "",
    });
  }

  return results;
}

function extractDdgLinks(html: string): Array<{ title: string; url: string }> {
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ title: string; url: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const rawHref = htmlDecode((match[1] ?? "").trim());
    const rawTitle = htmlDecode(stripTags(match[2] ?? "").replace(/\s+/g, " ").trim());
    const url = normalizeResultUrl(rawHref);

    if (url) {
      links.push({ title: rawTitle, url });
    }
  }

  return links;
}

function extractDdgSnippets(html: string): string[] {
  const pattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    snippets.push(htmlDecode(stripTags(match[1] ?? "").replace(/\s+/g, " ").trim()));
  }

  return snippets;
}

function normalizeResultUrl(rawUrl: string): string {
  if (!rawUrl) {
    return "";
  }

  if (rawUrl.includes("uddg=")) {
    const absolute =
      rawUrl.startsWith("//")
        ? `https:${rawUrl}`
        : rawUrl.startsWith("/")
          ? `https://duckduckgo.com${rawUrl}`
          : rawUrl;

    try {
      const target = new URL(absolute).searchParams.get("uddg");

      if (target) {
        return target;
      }
    } catch {
      // fall through to direct URL handling below
    }
  }

  if (rawUrl.startsWith("//")) {
    return `https:${rawUrl}`;
  }

  return /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
}

function assertHttpUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}