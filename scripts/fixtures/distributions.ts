/**
 * HAR distributions for the generator, measured on 12 Playwright 1.60 captures
 * of heavy public sites (6,158 entries, 588 JSON bodies; nearest-rank
 * percentiles). The numbers below are those measurements. The three entries
 * marked "synthetic" are shapes the captures did not contain but every fixture
 * must (DevTools' `_webSocketMessages`, NDJSON bodies, three-deep stringified
 * bodies), given a small share so the fixture has them.
 */
import type { Quantiles } from "./prng.ts";

export interface Weighted<T> {
  readonly value: T;
  readonly weight: number;
}

export const HAR = {
  /** entriesPerPage: p10 72, p50 282, p90 1083. */
  entriesPerPage: { median: 282, sigma: 0.9 },
  /** distinctHostsPerPage p50 17; each capture is a different site, so hosts are fresh per page. */
  hostsPerPage: 17,
  /** urlLength p50 98, p90 208, p99 1008 (path and query characters). */
  urlLength: { p10: 50, p25: 71, p50: 98, p75: 141, p90: 208, p99: 1008 } satisfies Quantiles,
  /** queryParamCount p50 2, p75 4, p90 6. */
  queryParams: [0, 0, 0, 0, 1, 1, 2, 2, 3, 4, 4, 6, 8] as const,
  /** requestHeaderCount p10 7, p50 9, p90 20. */
  requestHeaders: { p10: 7, p25: 8, p50: 9, p75: 12, p90: 20, p99: 21 } satisfies Quantiles,
  /** responseHeaderCount p10 6, p50 14, p90 32. */
  responseHeaders: { p10: 6, p25: 9, p50: 14, p75: 21, p90: 32, p99: 37 } satisfies Quantiles,
  /** requestCookieCount p50 0, p75 2, p90 5, p99 31. */
  requestCookies: [0, 0, 0, 0, 0, 0, 1, 2, 2, 3, 5, 5, 8] as const,
  /** responseSetCookieCount p75 1, p90 2, p99 6. */
  responseCookies: [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 6] as const,
  methods: [
    { value: "GET", weight: 0.9086 },
    { value: "POST", weight: 0.0901 },
    { value: "HEAD", weight: 0.0011 },
  ] satisfies ReadonlyArray<Weighted<string>>,
  /** postDataMimeMix among the 8.2 % of entries with a body; GraphQL is 0.23 % of all entries. */
  postMime: [
    { value: "text/plain", weight: 0.7857 },
    { value: "application/json", weight: 0.1925 },
    { value: "graphql", weight: 0.028 },
    { value: "application/x-www-form-urlencoded", weight: 0.0159 },
  ] satisfies ReadonlyArray<Weighted<string>>,
  postDataBytes: {
    "text/plain": { p10: 104, p25: 190, p50: 1089, p75: 2449, p90: 3241, p99: 49104 },
    "application/json": { p10: 47, p25: 233, p50: 623, p75: 1972, p90: 4731, p99: 32720 },
  } satisfies Record<string, Quantiles>,
  statuses: [
    { value: 200, weight: 0.7264 },
    { value: 302, weight: 0.2004 },
    { value: 204, weight: 0.0429 },
    { value: 307, weight: 0.0091 },
    { value: 303, weight: 0.0076 },
    { value: 301, weight: 0.0018 },
    { value: 403, weight: 0.0015 },
    { value: 400, weight: 0.0008 },
    { value: 401, weight: 0.0006 },
    { value: 404, weight: 0.0006 },
  ] satisfies ReadonlyArray<Weighted<number>>,
  /**
   * responseMimeMixByCount, grouped into the body kinds the generator writes.
   * `other` is x-unknown: no body text. `ndjson` and `websocket` are synthetic.
   */
  bodyKinds: [
    { value: "other", weight: 0.2399 },
    { value: "script", weight: 0.2466 },
    { value: "image", weight: 0.2502 },
    { value: "html", weight: 0.1132 },
    { value: "json", weight: 0.0934 },
    { value: "css", weight: 0.0255 },
    { value: "text", weight: 0.0135 },
    { value: "font", weight: 0.0102 },
    { value: "ndjson", weight: 0.004 },
    { value: "websocket", weight: 0.003 },
  ] satisfies ReadonlyArray<Weighted<string>>,
  /** bodyTextBytesByMime (text as stored in the HAR; images and fonts are base64 already). */
  bodyBytes: {
    script: { p10: 667, p25: 2517, p50: 11739, p75: 46073, p90: 141802, p99: 706390 },
    html: { p10: 1, p25: 1, p50: 354, p75: 2000, p90: 14627, p99: 391264 },
    json: { p10: 20, p25: 40, p50: 272, p75: 4008, p90: 27662, p99: 676853 },
    css: { p10: 200, p25: 636, p50: 3982, p75: 23178, p90: 159078, p99: 622285 },
    text: { p10: 1, p25: 1, p50: 64, p75: 576, p90: 51112, p99: 394153 },
    image: { p10: 48, p25: 140, p50: 808, p75: 9600, p90: 65584, p99: 364208 },
    font: { p10: 31372, p25: 31372, p50: 35536, p75: 57516, p90: 101800, p99: 140648 },
    ndjson: { p10: 200, p25: 500, p50: 2000, p75: 8000, p90: 30000, p99: 100000 },
  } satisfies Record<string, Quantiles>,
  imageMimes: [
    { value: "image/gif", weight: 0.0976 },
    { value: "image/avif", weight: 0.0628 },
    { value: "image/webp", weight: 0.0388 },
    { value: "image/png", weight: 0.0208 },
    { value: "image/jpeg", weight: 0.0106 },
  ] satisfies ReadonlyArray<Weighted<string>>,
  /** stringifiedJsonDepthClass among JSON bodies: 0 86.9 %, 1 11.7 %, 2 1.4 %; 3 is synthetic. */
  stringifiedDepth: [
    { value: 0, weight: 0.869 },
    { value: 1, weight: 0.1173 },
    { value: 2, weight: 0.0136 },
    { value: 3, weight: 0.004 },
  ] satisfies ReadonlyArray<Weighted<number>>,
  /** jwtShare 0.24 % of entries, in response bodies and request headers. */
  jwtShare: 0.0024,
  /** socketsPerPage mean 0.75; messagesPerSocket p90 11; messageSizeBytes p50 34, p90 711. */
  webSocketMessages: { min: 1, max: 11 },
  webSocketMessageBytes: {
    p10: 6,
    p25: 6,
    p50: 34,
    p75: 60,
    p90: 711,
    p99: 1730,
  } satisfies Quantiles,
  /** dns/ssl/connect apply to 15 % of entries; medians when present. */
  timings: {
    connectionShare: 0.15,
    dns: { p10: 0, p25: 1, p50: 73, p75: 152, p90: 235, p99: 391 },
    ssl: { p10: 28, p25: 35, p50: 44, p75: 52, p90: 90, p99: 175 },
    connect: { p10: 33, p25: 55, p50: 75, p75: 90, p90: 144, p99: 301 },
    wait: { p10: 32, p25: 38, p50: 45, p75: 63, p90: 110, p99: 325 },
    receive: { p10: 1.5, p25: 2.4, p50: 5.8, p75: 14.5, p90: 60, p99: 346 },
  },
  /** fixture2GiB: the giant body is image/avif in the captures' terms, base64 of 471,859,200 bytes. */
  giantBodyMime: "video/mp4",
} as const;
