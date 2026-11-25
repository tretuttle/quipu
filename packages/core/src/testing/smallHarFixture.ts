const utf8 = new TextEncoder();

const toBase64 = (text: string): string => {
  const bytes = utf8.encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const SESSION_CANARY = "sess_Q7mX4zR9kP2vLw8NbT3cYh6D";
const USER_CANARY = "usr_8c41f0a9d2e7";
const ORDER_CANARY = "NW-2024-118734";

/**
 * Builds a deterministic 147-entry HAR 1.2 fixture with nested encodings,
 * multi-entry session token occurrences, and realistic request timings.
 */
const isoAtOffsetMs = (offsetMs: number): string => {
  const totalSec = Math.floor(offsetMs / 1000);
  const ms = String(offsetMs % 1000).padStart(3, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  const min = String(Math.floor(totalSec / 60) % 60).padStart(2, "0");
  return `2026-10-04T12:${min}:${sec}.${ms}Z`;
};

export function buildSampleHarBytes(): Uint8Array<ArrayBuffer> {
  const entry21Payload = JSON.stringify(
    JSON.stringify(
      JSON.stringify({
        user: { id: USER_CANARY, displayName: "Demo Reviewer", tier: "pro" },
        permissions: ["reviews:write", "wishlist:read"],
      }),
    ),
  );
  const entry28Payload = JSON.stringify(
    JSON.stringify(
      JSON.stringify({
        order: {
          number: ORDER_CANARY,
          status: "shipped",
          carrier: "Cascade Freight",
          tracking: "1ZDEMO0001",
        },
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
          session: {
            token: SESSION_CANARY,
            expiresAt: "2026-10-04T13:00:00.000Z",
            viewer: { id: "usr_demo01", tier: "standard" },
          },
          cart: { id: "cart_01", items: 2 },
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
    } else if (i === 28) {
      method = "GET";
      path = `/api/v1/orders/${ORDER_CANARY}/status`;
      status = 200;
      responseContent = {
        size: entry28Payload.length,
        mimeType: "application/json; charset=utf-8",
        text: entry28Payload,
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
          query:
            "query GetUserOrders($userId: ID!, $first: Int = 10) { user(id: $userId) { id name } }",
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
        headers: [
          { name: "content-type", value: responseContent.mimeType },
          { name: "cache-control", value: "private, no-store" },
        ],
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

  return new Uint8Array(
    utf8.encode(
      JSON.stringify({
        log: {
          version: "1.2",
          creator: { name: "quipu-fixture", version: "1.0" },
          pages: [
            {
              startedDateTime: "2026-10-04T12:00:00.000Z",
              id: "page_1",
              title: "Shop Session",
              pageTimings: { onContentLoad: 420, onLoad: 1180 },
            },
          ],
          entries,
        },
      }),
    ),
  );
}
