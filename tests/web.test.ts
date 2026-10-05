import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { extractPageTitle, fetchWebPage, htmlToPlainText, isUnsafeWebHost, searchWeb, type Fetcher } from "../src/web.js";
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
      const page = await fetchWebPage(`${baseUrl}/page`, { allowPrivateNetwork: true });

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
      await assert.rejects(fetchWebPage(`${baseUrl}/missing`, { allowPrivateNetwork: true }), /status 404/);
    },
  );
});

test("fetchWebPage rejects non-http schemes", async () => {
  await assert.rejects(fetchWebPage("file:///etc/passwd"), /Only http and https/);
  await assert.rejects(fetchWebPage("not a url"), /Invalid URL/);
});

test("isUnsafeWebHost flags private, loopback, and local addresses", () => {
  assert.equal(isUnsafeWebHost("127.0.0.1"), true);
  assert.equal(isUnsafeWebHost("10.0.0.5"), true);
  assert.equal(isUnsafeWebHost("172.16.0.1"), true);
  assert.equal(isUnsafeWebHost("192.168.1.1"), true);
  assert.equal(isUnsafeWebHost("169.254.169.254"), true);
  assert.equal(isUnsafeWebHost("localhost"), true);
  assert.equal(isUnsafeWebHost("service.internal"), true);
  assert.equal(isUnsafeWebHost("::1"), true);
  assert.equal(isUnsafeWebHost("example.com"), false);
  assert.equal(isUnsafeWebHost("8.8.8.8"), false);
});

test("fetchWebPage blocks private hosts unless allowPrivateNetwork is set", async () => {
  await assert.rejects(fetchWebPage("http://169.254.169.254/"), /private or local network/);
  await assert.rejects(fetchWebPage("http://127.0.0.1:8080/"), /private or local network/);
});

test("fetchWebPage follows a local redirect when allowed", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/target" });
        res.end();
        return;
      }

      sendHtml(res, "<html><head><title>Redirected</title></head><body>final</body></html>");
    },
    async (baseUrl) => {
      const page = await fetchWebPage(`${baseUrl}/redirect`, { allowPrivateNetwork: true });

      assert.equal(page.title, "Redirected");
      assert.match(page.text, /final/);
    },
  );
});

test("fetchWebPage blocks redirects to private hosts", async () => {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);

    return {
      ok: true,
      status: 302,
      headers: { get: (name) => (name === "location" ? "http://169.254.169.254/" : null) },
      text: async () => "",
    };
  };

  await assert.rejects(
    fetchWebPage("https://public.example/page", {
      fetcher,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    /private or local network/,
  );
  assert.deepEqual(calls, ["https://public.example/page"]);
});

test("fetchWebPage caps redirect hops", async () => {
  const fetcher: Fetcher = async (url) => ({
    ok: true,
    status: 302,
    headers: { get: (name) => (name === "location" ? "https://public.example/loop" : null) },
    text: async () => "",
  });

  await assert.rejects(
    fetchWebPage("https://public.example/loop", {
      fetcher,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    /Redirected more than/,
  );
});

test("fetchWebPage blocks a hostname resolving to a private address", async () => {
  const resolveHost = async () => [{ address: "10.0.0.5", family: 4 }];

  await assert.rejects(
    fetchWebPage("https://rebind.example/page", { resolveHost }),
    /private or local network/,
  );
});

test("fetchWebPage allows a hostname resolving to a public address", async () => {
  const resolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
  const fetcher: Fetcher = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "<html><body>public ok</body></html>",
  });

  const page = await fetchWebPage("https://rebind.example/page", { fetcher, resolveHost });

  assert.match(page.text, /public ok/);
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