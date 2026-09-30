import { randomBytes } from "node:crypto";

// Prefixed ULIDs: 48-bit millisecond time + 80 random bits, Crockford base32.
// Lexicographic order is creation order, which gives cursor pagination a stable
// total order. Monotonic within one process; across PM2 cluster workers two ids
// minted in the same millisecond are ordered arbitrarily but still totally.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type IdPrefix = "ctr" | "cred" | "rec" | "rev" | "ann" | "mod" | "req";

let lastTime = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  let random: bigint;
  if (now === lastTime) {
    random = (lastRandom + 1n) & ((1n << 80n) - 1n);
  } else {
    random = BigInt("0x" + randomBytes(10).toString("hex"));
  }
  lastTime = now;
  lastRandom = random;
  return encode(BigInt(now), 10) + encode(random, 16);
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export const ID_PATTERN = {
  revision: "^rev_[0-9A-HJKMNP-TV-Z]{26}$",
  record: "^rec_[0-9A-HJKMNP-TV-Z]{26}$",
  annotation: "^ann_[0-9A-HJKMNP-TV-Z]{26}$",
} as const;
