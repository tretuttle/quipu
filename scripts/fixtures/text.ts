/**
 * Deterministic text helpers shared by the generators: words, hosts, URLs,
 * identifiers, JWTs and base64. Everything derives from the Prng it is handed.
 */
import type { Prng } from "./prng.ts";

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
  "quipu",
  "khipu",
  "cord",
  "knot",
  "café",
  "naïve",
  "résumé",
  "東京",
  "北京",
  "Zürich",
  "🙂",
  "🚀",
  "🧵",
  "données",
];

const UNSAFE = ['"', "\\", "\n", "\t", "/", "\u0001", "é", "😀", "<", "&"];

export const word = (prng: Prng) => prng.pick(WORDS);

export const words = (prng: Prng, count: number) => {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(word(prng));
  return out.join(" ");
};

/** A sentence that sometimes carries characters JSON must escape. */
export const sentence = (prng: Prng) => {
  const base = words(prng, prng.range(3, 14));
  return prng.chance(0.15) ? `${base} ${prng.pick(UNSAFE)}${word(prng)}` : base;
};

/** Text of about `chars` characters built from sentences. */
export const prose = (prng: Prng, chars: number) => {
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const s = sentence(prng);
    parts.push(s);
    length += s.length + 1;
  }
  return parts.join(" ");
};

export const hex = (prng: Prng, bytes: number) => {
  let out = "";
  for (let i = 0; i < bytes; i++) out += (prng.nextU32() & 0xff).toString(16).padStart(2, "0");
  return out;
};

export const uuid = (prng: Prng) => {
  const h = hex(prng, 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Base64 of `bytes` random bytes. */
export const base64 = (prng: Prng, bytes: number) => {
  const words32 = new Uint32Array(Math.ceil(bytes / 4));
  prng.fillWords(words32);
  return Buffer.from(words32.buffer, 0, bytes).toString("base64");
};

const base64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

export const jwt = (prng: Prng, issuedAt: number) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: hex(prng, 8) }));
  const payload = base64url(
    JSON.stringify({
      sub: uuid(prng),
      iss: `https://auth.${word(prng)}.example`,
      aud: ["api", "web"],
      iat: issuedAt,
      exp: issuedAt + 3600,
      scope: "openid profile email",
      roles: [word(prng), word(prng)],
    }),
  );
  const signature = Buffer.from(randomBytes(prng, 32)).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

const randomBytes = (prng: Prng, count: number) => {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = prng.nextU32() & 0xff;
  return out;
};

const TLDS = ["com", "io", "dev", "net", "org", "app", "co.uk", "de", "jp"];
const PREFIXES = [
  "api",
  "cdn",
  "static",
  "www",
  "img",
  "auth",
  "ws",
  "edge",
  "assets",
  "graph",
  "events",
];

export const hosts = (prng: Prng, count: number) => {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      `${prng.pick(PREFIXES)}${prng.chance(0.3) ? prng.int(10) : ""}.${word(prng)}-${word(prng)}.${prng.pick(TLDS)}`,
    );
  }
  return out;
};

/** ISO-8601 for a millisecond timestamp, without touching the global Date. */
export const isoDate = (ms: number) => {
  const days = Math.floor(ms / 86_400_000);
  const rem = ms - days * 86_400_000;
  // Civil-from-days (Howard Hinnant), valid for the fixture's 2026 dates.
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");
  const hours = Math.floor(rem / 3_600_000);
  const minutes = Math.floor((rem % 3_600_000) / 60_000);
  const seconds = Math.floor((rem % 60_000) / 1000);
  const millis = rem % 1000;
  return `${year}-${pad(m)}-${pad(d)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}Z`;
};

export const number = (prng: Prng) => {
  switch (prng.int(6)) {
    case 0:
      return prng.int(1_000_000);
    case 1:
      return -prng.int(10_000);
    case 2:
      return Math.round(prng.float() * 1e6) / 1e3;
    case 3:
      return Number((prng.float() * 1e-5).toExponential(4));
    case 4:
      return prng.int(2) === 0 ? 0 : 1;
    default:
      return Math.round(prng.float() * 1e9);
  }
};

export const weighted = <T>(
  prng: Prng,
  items: ReadonlyArray<{ readonly value: T; readonly weight: number }>,
): T => {
  let total = 0;
  for (const item of items) total += item.weight;
  let roll = prng.float() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item.value;
  }
  return (items[items.length - 1] as { value: T }).value;
};
