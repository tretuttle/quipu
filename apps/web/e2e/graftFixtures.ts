// @effect-diagnostics nodeBuiltinImport:off - generates deterministic E2E test fixtures in a temp directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const utf8 = new TextEncoder();

const toBase64 = (text: string): string => {
  const bytes = utf8.encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export interface GeneratedFixtures {
  readonly dir: string;
  readonly smallHar: string;
  readonly orderTraceHar: string;
  readonly mediumHar: string;
  readonly largeEventsJson: string;
  readonly diffAHar: string;
  readonly diffEHar: string;
  readonly orderSchema: string;
  readonly remoteSchema: string;
  readonly cleanup: () => void;
}

const SESSION_CANARY = "sess_Q7mX4zR9kP2vLw8NbT3cYh6D";
const USER_CANARY = "usr_8c41f0a9d2e7";

const isoAtOffsetMs = (offsetMs: number): string => {
  const totalSec = Math.floor(offsetMs / 1000);
  const ms = String(offsetMs % 1000).padStart(3, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  const min = String(Math.floor(totalSec / 60) % 60).padStart(2, "0");
  return `2026-10-04T12:${min}:${sec}.${ms}Z`;
};

function buildSmallHarJson(): string {
  const entry21Payload = JSON.stringify(
    JSON.stringify(
      JSON.stringify({
        user: { id: USER_CANARY, displayName: "Demo Reviewer", tier: "pro" },
        permissions: ["reviews:write", "wishlist:read"],
      }),
    ),
  );
  const entry34Variables = JSON.stringify({ userId: USER_CANARY, first: 10 });

  const entries = Array.from({ length: 147 }, (_, i) => {
    const isApi = i % 2 === 0;
    let method = i % 5 === 0 ? "POST" : "GET";
    let host = isApi ? "api.shop.example" : "cdn.shop.example";
    let path = isApi ? `/api/v1/catalog?page=${(i % 10) + 1}&per_page=50` : `/assets/chunk-${i}.js`;
    let status = i % 17 === 0 ? 404 : i % 11 === 0 ? 201 : 200;
    let postData: { mimeType: string; text: string } | undefined;
    let responseContent: {
      size: number;
      mimeType: string;
      text: string;
      encoding?: "base64";
    } = {
      size: 64,
      mimeType: isApi ? "application/json; charset=utf-8" : "application/javascript",
      text: isApi ? JSON.stringify({ page: i, ok: true }) : `/* chunk ${i} */`,
    };

    if (i === 3) {
      method = "POST";
      path = "/api/v1/session";
      status = 200;
      postData = { mimeType: "application/json", text: JSON.stringify({ device: "web" }) };
      responseContent = {
        size: 160,
        mimeType: "application/json; charset=utf-8",
        text: JSON.stringify({
          session: { token: SESSION_CANARY, expiresAt: "2026-10-04T13:00:00.000Z" },
        }),
      };
    } else if (i === 10) {
      method = "GET";
      path = "/api/v1/addresses?page=6&per_page=50";
      status = 200;
    } else if (i === 21) {
      method = "GET";
      path = "/api/v1/profiles/public?ref=review-card";
      status = 200;
      responseContent = {
        size: entry21Payload.length,
        mimeType: "application/json",
        encoding: "base64",
        text: toBase64(entry21Payload),
      };
    } else if (i === 34) {
      method = "POST";
      host = "graphql.shop.example";
      path = "/graphql";
      status = 200;
      postData = {
        mimeType: "application/json",
        text: JSON.stringify({
          operationName: "GetUserOrders",
          query: "query GetUserOrders($userId: ID!) { user(id: $userId) { id } }",
          variables: entry34Variables,
        }),
      };
    } else if (i === 57 || i === 146) {
      method = "GET";
      path = `/api/v1/wishlist?page=${i}&per_page=50`;
      status = 200;
    }

    const sessionHeader = i === 10 || i === 57 || i === 146 ? SESSION_CANARY : `sess_other_${i}`;
    const wait = 25 + (i % 12) * 18;
    const receive = 4 + (i % 5) * 6;
    const connect = i % 6 === 0 ? 12 : -1;
    const dns = i % 6 === 0 ? 6 : -1;
    const ssl = i % 6 === 0 ? 9 : -1;
    const blocked = 2 + (i % 3);
    const send = 1;
    const time =
      blocked + (dns > 0 ? dns : 0) + (connect > 0 ? connect : 0) + send + wait + receive;

    return {
      _resourceType: isApi ? "fetch" : "script",
      pageref: "page_1",
      startedDateTime: isoAtOffsetMs(i * 85),
      time,
      request: {
        method,
        url: `https://${host}${path}`,
        httpVersion: "h2",
        headers: [
          { name: ":authority", value: host },
          { name: ":method", value: method },
          { name: ":path", value: path },
          { name: ":scheme", value: "https" },
          { name: "accept", value: isApi ? "application/json" : "*/*" },
          { name: "accept-encoding", value: "gzip, deflate, br" },
          { name: "accept-language", value: "en-US,en;q=0.9" },
          { name: "user-agent", value: "Mozilla/5.0 (X11; Linux x86_64)" },
          { name: "x-session-token", value: sessionHeader },
        ],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: postData ? postData.text.length : 0,
        ...(postData ? { postData } : {}),
      },
      response: {
        status,
        statusText: "",
        httpVersion: "h2",
        headers: [{ name: "content-type", value: responseContent.mimeType }],
        cookies: [],
        content: responseContent,
        redirectURL: "",
        headersSize: -1,
        bodySize: responseContent.size,
      },
      cache: {},
      timings: { blocked, dns, ssl, connect, send, wait, receive },
    };
  });

  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "quipu-fixture", version: "1.0" },
      pages: [{ startedDateTime: "2026-10-04T12:00:00.000Z", id: "page_1", title: "Shop" }],
      entries,
    },
  });
}

function buildOrderTraceHarJson(): string {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "quipu-fixture", version: "1.0" },
      entries: [
        {
          startedDateTime: "2026-10-04T18:00:00.100Z",
          time: 42.5,
          request: {
            method: "GET",
            url: "https://api.example.com/v1/users/1",
            headers: [{ name: "accept", value: "application/json" }],
            queryString: [],
          },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "application/json" }],
            content: {
              size: 22,
              mimeType: "application/json",
              text: JSON.stringify({ id: 1, role: "admin" }),
            },
          },
        },
        {
          startedDateTime: "2026-10-04T18:00:00.200Z",
          time: 31,
          request: {
            method: "POST",
            url: "https://api.example.com/v1/auth",
            headers: [{ name: "content-type", value: "application/json" }],
            queryString: [],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({ grant: "refresh" }),
            },
          },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "application/json" }],
            content: {
              size: 37,
              mimeType: "application/json",
              encoding: "base64",
              text: toBase64(JSON.stringify({ token: "tok_smoke_decoded", ok: true })),
            },
          },
        },
      ],
    },
  });
}

function buildMediumHarJson(): string {
  const entries = Array.from({ length: 1200 }, (_, i) => ({
    _resourceType: "fetch",
    startedDateTime: isoAtOffsetMs(i * 20),
    time: 18 + (i % 10),
    request: {
      method: "GET",
      url: `https://api.shop.example/v1/items/${i}`,
      headers: [{ name: "accept", value: "application/json" }],
      queryString: [],
    },
    response: {
      status: i < 117 ? (i % 3 === 0 ? 500 : 404) : 200,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { size: 18, mimeType: "application/json", text: `{"id":${i}}` },
    },
  }));
  return JSON.stringify({
    log: { version: "1.2", creator: { name: "quipu-fixture", version: "1.0" }, entries },
  });
}

function writeLargeEventsJson(filePath: string): void {
  const total = 290_000;
  const targetMatches = 3997;
  const pad = "x".repeat(160);
  const fd = NodeFS.openSync(filePath, "w");
  try {
    NodeFS.writeSync(fd, "[\n");
    const chunkLines: string[] = [];
    for (let i = 0; i < total; i++) {
      const isMatch = i < targetMatches;
      const line = `{"id":${i},"type":"event","duration_ms":${isMatch ? 5005 : 120},"user":{"id":"u_${i}","plan":"${isMatch ? "pro" : "free"}"},"pad":"${pad}"}${i + 1 < total ? "," : ""}\n`;
      chunkLines.push(line);
      if (chunkLines.length >= 2000) {
        NodeFS.writeSync(fd, chunkLines.join(""));
        chunkLines.length = 0;
      }
    }
    if (chunkLines.length > 0) NodeFS.writeSync(fd, chunkLines.join(""));
    NodeFS.writeSync(fd, "]\n");
  } finally {
    NodeFS.closeSync(fd);
  }
}

function buildDiffHarPair(): { readonly a: string; readonly e: string } {
  const makeEntry = (
    method: string,
    url: string,
    status: number,
    body: unknown,
    started = "2026-10-04T12:00:00.000Z",
  ) => ({
    startedDateTime: started,
    time: 40,
    _resourceType: "fetch",
    request: {
      method,
      url,
      httpVersion: "HTTP/2",
      headers: [{ name: "Accept", value: "application/json" }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status,
      statusText: "",
      httpVersion: "HTTP/2",
      headers: [{ name: "Content-Type", value: "application/json" }],
      cookies: [],
      content: { size: 32, mimeType: "application/json", text: JSON.stringify(body) },
      redirectURL: "",
      headersSize: -1,
      bodySize: 32,
    },
    cache: {},
    timings: { send: 1, wait: 35, receive: 4 },
  });

  const shared = [
    makeEntry("GET", "https://api.shop.test/v1/session", 200, { ok: true, user: "ada" }),
    makeEntry("GET", "https://api.shop.test/v1/catalog", 200, { items: [1, 2, 3] }),
    makeEntry("GET", "https://api.shop.test/v1/cart", 200, { count: 2 }),
    makeEntry("GET", "https://api.shop.test/v1/flags", 200, { darkMode: true }),
    makeEntry("GET", "https://api.shop.test/v1/profile", 200, { tier: "pro" }),
  ];

  const a = {
    log: {
      version: "1.2",
      creator: { name: "har diff fixture", version: "1" },
      pages: [],
      entries: [
        ...shared,
        makeEntry("GET", "https://api.shop.test/v1/order/7", 200, {
          id: 7,
          status: "pending",
          total: 42,
        }),
        makeEntry("GET", "https://api.shop.test/v1/recommendations", 200, { picks: ["A", "B"] }),
      ],
    },
  };
  const e = {
    log: {
      version: "1.2",
      creator: { name: "har diff fixture", version: "1" },
      pages: [],
      entries: [
        ...shared,
        makeEntry("GET", "https://api.shop.test/v1/order/7", 200, {
          id: 7,
          status: "shipped",
          total: 42,
        }),
        makeEntry("GET", "https://api.shop.test/v1/weather", 200, { tempC: 18 }),
      ],
    },
  };
  return { a: JSON.stringify(a), e: JSON.stringify(e) };
}

const ORDER_SCHEMA_JSON = JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.shop.test/order.schema.json",
    title: "Order",
    type: "object",
    required: ["order"],
    properties: {
      order: {
        type: "object",
        required: ["id", "price", "currency"],
        properties: {
          id: { type: "integer", minimum: 1 },
          price: { $ref: "#/$defs/price" },
          currency: { enum: ["USD", "EUR"] },
          items: { type: "array", items: { type: "string" } },
        },
      },
    },
    $defs: {
      price: { type: "number", minimum: 0, maximum: 10 },
    },
  },
  null,
  2,
);

const REMOTE_SCHEMA_JSON = JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      order: { $ref: "https://schemas.shop.test/order.schema.json#/properties/order" },
    },
  },
  null,
  2,
);

export function createE2eFixtures(): GeneratedFixtures {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-e2e-"));
  const smallHar = NodePath.join(dir, "small.har");
  const orderTraceHar = NodePath.join(dir, "order-trace.har");
  const mediumHar = NodePath.join(dir, "medium.har");
  const largeEventsJson = NodePath.join(dir, "large-events.json");
  const diffAHar = NodePath.join(dir, "diff-a.har");
  const diffEHar = NodePath.join(dir, "diff-e.har");
  const diffPair = buildDiffHarPair();

  NodeFS.writeFileSync(smallHar, buildSmallHarJson(), "utf8");
  NodeFS.writeFileSync(orderTraceHar, buildOrderTraceHarJson(), "utf8");
  NodeFS.writeFileSync(mediumHar, buildMediumHarJson(), "utf8");
  writeLargeEventsJson(largeEventsJson);
  NodeFS.writeFileSync(diffAHar, diffPair.a, "utf8");
  NodeFS.writeFileSync(diffEHar, diffPair.e, "utf8");

  return {
    dir,
    smallHar,
    orderTraceHar,
    mediumHar,
    largeEventsJson,
    diffAHar,
    diffEHar,
    orderSchema: ORDER_SCHEMA_JSON,
    remoteSchema: REMOTE_SCHEMA_JSON,
    cleanup: () => {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}
