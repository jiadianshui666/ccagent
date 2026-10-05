import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { extractPageTitle, fetchWebPage, htmlToPlainText, searchWeb } from "../src/web.js";
import { WebFetchTool } from "../src/tools/webFetch.js";
import { WebSearchTool } from "../src/tools/webSearch.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

test("htmlToPlainText strips tags, scripts, and decodes entities", () => {
  const { text, truncated } = htmlToPlainText(
    "<html><head><title>x</title><style>p { color: red; }</style></head><body><script>var a = 1;</script><h1>Hello</h1><p>A &amp; B&nbsp;c</p></body></html>",
    1000,
  );

  assert.equal(text, "Hello A & B c");
  assert.equal(truncated, false);
});

test("htmlToPlainText truncates long content and marks it truncated", () => {
  const { text, truncated } = htmlToPlainText("a".repeat(100), 20);

  assert.equal(text, "a".repeat(20));
  assert.equal(truncated, true);
});

test("extractPageTitle reads and decodes the title element", () => {
  assert.equal(extractPageTitle("<html><head><title>Hello &amp; world</title></head></html>"), "Hello & world");
  assert.equal(extractPageTitle("<html><body>no title</body></html>"), undefined);
});

test("fetchWebPage retrieves title and plain text over HTTP", async () => {
  await withServer(
    (req, res) => {
      sendHtml(res, "<html><head><title>Example</title></head><body><h1>Heading</h1><p>Some body text.</p></body></html>");
    },
    async (baseUrl) => {
      const page = await fetchWebPage(`${baseUrl}/page`);

      assert.equal(page.title, "Example");
      assert.match(page.text, /Heading/);
      assert.match(page.text, /Some body text\./);
      assert.equal(page.truncated, false);
    },
  );
});

test("fetchWebPage fails on non-2xx responses", async () => {
  await withServer(
    (req, res) => {
      sendHtml(res, "<html><body>gone</body></html>", 404);
    },
    async (baseUrl) => {
      await assert.rejects(fetchWebPage(`${baseUrl}/missing`), /status 404/);
    },
  );
});

test("fetchWebPage rejects non-http schemes", async () => {
  await assert.rejects(fetchWebPage("file:///etc/passwd"), /Only http and https/);
  await assert.rejects(fetchWebPage("not a url"), /Invalid URL/);
});

test("searchWeb parses DuckDuckGo results and decodes redirect URLs", async () => {
  const html = [
    "<html><body>",
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>',
    '<a class="result__snippet" href="https://example.com/page">A first result snippet.</a>',
    '<a rel="nofollow" class="result__a" href="https://second.example/other">Second &amp; Page</a>',
    '<a class="result__snippet" href="https://second.example/other">Second snippet text.</a>',
    "</body></html>",
  ].join("");

  await withServer(
    (req, res) => {
      sendHtml(res, html);
    },
    async (baseUrl) => {
      const results = await searchWeb("example query", { baseUrl: `${baseUrl}/html/` });

      assert.deepEqual(results, [
        { title: "Example Page", url: "https://example.com/page", snippet: "A first result snippet." },
        { title: "Second & Page", url: "https://second.example/other", snippet: "Second snippet text." },
      ]);
    },
  );
});

test("searchWeb rejects an empty query", async () => {
  await assert.rejects(searchWeb("   "), /non-empty/);
});

test("WebFetchTool rejects an empty url", async () => {
  const result = await new WebFetchTool().execute({ url: "  " }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /non-empty string/);
});

test("WebSearchTool rejects an empty query", async () => {
  const result = await new WebSearchTool().execute({ query: "" }, { workspaceRoot: "." });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /non-empty string/);
});