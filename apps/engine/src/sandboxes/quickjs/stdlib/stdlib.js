// sk-Stdlib v1 — curated helper surface for user-supplied JavaScript
// running inside the QuickJS sandbox (before-request hooks,
// transform steps with language: "javascript").
//
// Injected via `context.evalCode(STDLIB_SOURCE, "sk-stdlib.js")` in
// runtime.ts before the user's code runs. Installs `globalThis.sk`
// and freezes it so user code cannot mutate or replace the surface.
//
// Determinism: no Date.now, no Math.random, no host I/O.
// `sk.now()` and `sk.uuid()` are deterministic — they derive from a
// per-execution timestamp and seed the host injects (`__sandbox_now__`,
// `__sandbox_seed__`), NOT from a live clock or RNG. A run replayed with
// the same execution context yields byte-identical now()/uuid() values,
// which is what keeps self-healing dry-runs reproducible.
// Keep this file plain ES2020 — it is evaluated, not transpiled.

(function installSkStdlib() {
  const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
  const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

  function normalizeMethod(m) {
    return typeof m === "string" ? m.toUpperCase() : "";
  }

  function isMutating(method) {
    return WRITE_METHODS.indexOf(normalizeMethod(method)) !== -1;
  }

  function isSafe(method) {
    return READ_METHODS.indexOf(normalizeMethod(method)) !== -1;
  }

  function splitPath(path) {
    if (Array.isArray(path)) return path.slice();
    if (typeof path !== "string" || path.length === 0) return [];
    return path.split(".");
  }

  function get(obj, path, fallback) {
    const parts = splitPath(path);
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[parts[i]];
    }
    return cur === undefined ? fallback : cur;
  }

  function has(obj, path) {
    const parts = splitPath(path);
    if (parts.length === 0) return false;
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return false;
      if (!Object.hasOwn(cur, parts[i])) return false;
      cur = cur[parts[i]];
    }
    return true;
  }

  function allow() {
    return { allow: true };
  }

  function deny(reason) {
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TypeError("sk.deny(reason) requires a non-empty string reason");
    }
    return { allow: false, reason: reason };
  }

  function pick(obj, keys) {
    if (obj === null || typeof obj !== "object") return {};
    if (!Array.isArray(keys)) return {};
    const out = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (Object.hasOwn(obj, k)) {
        out[k] = obj[k];
      }
    }
    return out;
  }

  function omit(obj, keys) {
    if (obj === null || typeof obj !== "object") return {};
    if (!Array.isArray(keys)) return Object.assign({}, obj);
    const drop = {};
    for (let i = 0; i < keys.length; i++) drop[keys[i]] = true;
    const out = {};
    const names = Object.keys(obj);
    for (let j = 0; j < names.length; j++) {
      const n = names[j];
      if (!drop[n]) out[n] = obj[n];
    }
    return out;
  }

  function pluck(arr, key) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      out.push(el !== null && typeof el === "object" ? el[key] : undefined);
    }
    return out;
  }

  function groupBy(arr, keyOrFn) {
    if (!Array.isArray(arr)) return {};
    const out = {};
    const fn =
      typeof keyOrFn === "function"
        ? keyOrFn
        : (item) => (item !== null && typeof item === "object" ? item[keyOrFn] : undefined);
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const k = fn(item);
      const key = k === undefined || k === null ? "" : String(k);
      if (!Object.hasOwn(out, key)) out[key] = [];
      out[key].push(item);
    }
    return out;
  }

  function uniq(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = {};
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      const type = v === null ? "null" : typeof v;
      if (type !== "string" && type !== "number" && type !== "boolean" && type !== "null") {
        out.push(v);
        continue;
      }
      const token = `${type}:${String(v)}`;
      if (!seen[token]) {
        seen[token] = true;
        out.push(v);
      }
    }
    return out;
  }

  // ── Base64 ────────────────────────────────────────────────────────
  // The sandbox installs no host globals, so `btoa`/`Buffer`/TextEncoder
  // are absent. Email-send (`raw` as base64url MIME) and git-commit
  // (`content` as base64) workflows universally need encoding, so it
  // belongs on the curated surface rather than re-implemented per
  // transform.
  //
  // `base64Encode` is deliberately IDENTICAL to jsonata's `$base64encode`
  // (each character contributes one byte = its low 8 bits — the "binary
  // string" convention, not UTF-8). This is what lets a transform move
  // from jsonata to javascript with byte-for-byte the same output.
  //
  // `base64EncodeUtf8` is the explicit Unicode-safe helper for new MIME
  // and API payloads. Keeping both names prevents a migration from
  // silently changing historical outputs while still giving new code the
  // encoding most external APIs expect.
  const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function stringInput(input) {
    return typeof input === "string" ? input : String(input);
  }

  function binaryBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
    return bytes;
  }

  function utf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let codePoint = str.charCodeAt(i);
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
          i += 1;
        } else {
          codePoint = 0xfffd;
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd;
      }

      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      }
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    let out = "";
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < len ? bytes[i + 1] : 0;
      const b2 = i + 2 < len ? bytes[i + 2] : 0;
      out += B64_ALPHABET[b0 >> 2];
      out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
      out += i + 1 < len ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      out += i + 2 < len ? B64_ALPHABET[b2 & 63] : "=";
    }
    return out;
  }

  function base64Encode(input) {
    return bytesToBase64(binaryBytes(stringInput(input)));
  }

  function base64EncodeUtf8(input) {
    return bytesToBase64(utf8Bytes(stringInput(input)));
  }

  // base64url: the standard alphabet with `+`→`-`, `/`→`_`. Padding (`=`)
  // is preserved, matching the prevailing `$replace($replace(
  // $base64encode(x),'+','-'),'/','_')` jsonata idiom these workflows use
  // for the Gmail `raw` field.
  function base64UrlEncode(input) {
    return base64Encode(input).replace(/\+/g, "-").replace(/\//g, "_");
  }

  function base64UrlEncodeUtf8(input) {
    return base64EncodeUtf8(input).replace(/\+/g, "-").replace(/\//g, "_");
  }

  // Decode side — absent before v1.3.0, which forced transforms to either
  // hand-roll a decoder or give up. Accepts BOTH the standard (`+`/`/`) and
  // url-safe (`-`/`_`) alphabets and tolerates missing padding, so a value
  // produced by any of the encoders above round-trips. Whitespace is ignored.
  const B64_LOOKUP = (function buildLookup() {
    const table = {};
    for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET[i]] = i;
    table["-"] = 62; // url-safe `+`
    table._ = 63; // url-safe `/`
    return table;
  })();

  function base64ToBytes(input) {
    const str = stringInput(input).replace(/[\s=]/g, "");
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < str.length; i++) {
      const v = B64_LOOKUP[str[i]];
      if (v === undefined) throw new Error(`base64Decode: invalid character at index ${i}`);
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }
    return bytes;
  }

  // Inverse of `base64Encode`: returns a "binary string" (one char per byte,
  // low 8 bits) — Web `atob` semantics.
  function base64Decode(input) {
    const bytes = base64ToBytes(input);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  // Inverse of `base64EncodeUtf8`: decodes the bytes as UTF-8 back to a
  // JS string (handles multi-byte sequences and surrogate pairs).
  function base64DecodeUtf8(input) {
    const bytes = base64ToBytes(input);
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++];
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
      } else if (b0 >= 0xc0 && b0 < 0xe0) {
        const b1 = bytes[i++] & 0x3f;
        out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
      } else if (b0 >= 0xe0 && b0 < 0xf0) {
        const b1 = bytes[i++] & 0x3f;
        const b2 = bytes[i++] & 0x3f;
        out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
      } else {
        const b1 = bytes[i++] & 0x3f;
        const b2 = bytes[i++] & 0x3f;
        const b3 = bytes[i++] & 0x3f;
        let cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  // ── Hex ───────────────────────────────────────────────────────────
  // Lowercase hex of the binary-string bytes (one low-8-bit byte per
  // UTF-16 code unit), matching the base64Encode byte convention so the
  // two encoders agree on what "the bytes of a string" are.
  const HEX = "0123456789abcdef";

  function hexEncode(input) {
    const bytes = binaryBytes(stringInput(input));
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += HEX[(bytes[i] >> 4) & 15] + HEX[bytes[i] & 15];
    }
    return out;
  }

  function hexDecode(input) {
    const str = stringInput(input).replace(/\s/g, "");
    if (str.length % 2 !== 0) throw new Error("hexDecode: odd-length input");
    let out = "";
    for (let i = 0; i < str.length; i += 2) {
      const byte = parseInt(str.substr(i, 2), 16);
      if (Number.isNaN(byte)) {
        throw new Error(`hexDecode: invalid hex at index ${i}`);
      }
      out += String.fromCharCode(byte);
    }
    return out;
  }

  // ── SHA-256 / HMAC-SHA-256 ─────────────────────────────────────────
  // Pure FIPS-180-4 implementation over the UTF-8 bytes of the input.
  // No host crypto, no clock, no random — fully deterministic so a
  // signed-payload transform reproduces byte-for-byte under self-healing
  // dry-runs (where `crypto.subtle` is absent and `Buffer` is too).
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // Returns the 32-byte digest of `bytes` (array of 0..255) as an array
  // of bytes.
  function sha256Bytes(bytes) {
    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ];
    const len = bytes.length;
    const bitLen = len * 8;
    // Pad: append 0x80, then zeros, then 64-bit big-endian length.
    const padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    // 64-bit length, big-endian. Lengths fit in 32 bits for any realistic
    // sandbox input, so the high word is zero.
    padded.push(0, 0, 0, 0);
    padded.push(
      (bitLen >>> 24) & 0xff,
      (bitLen >>> 16) & 0xff,
      (bitLen >>> 8) & 0xff,
      bitLen & 0xff,
    );

    const w = new Array(64);
    for (let i = 0; i < padded.length; i += 64) {
      for (let t = 0; t < 16; t++) {
        const j = i + t * 4;
        w[t] =
          ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
      }
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let a = h[0],
        b = h[1],
        c = h[2],
        d = h[3],
        e = h[4],
        f = h[5],
        g = h[6],
        hh = h[7];
      for (let t = 0; t < 64; t++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff);
    }
    return out;
  }

  function bytesToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += HEX[(bytes[i] >> 4) & 15] + HEX[bytes[i] & 15];
    return out;
  }

  function sha256(input) {
    return bytesToHex(sha256Bytes(utf8Bytes(stringInput(input))));
  }

  function hmacSha256(key, msg) {
    const blockSize = 64;
    let keyBytes = utf8Bytes(stringInput(key));
    if (keyBytes.length > blockSize) keyBytes = sha256Bytes(keyBytes);
    while (keyBytes.length < blockSize) keyBytes.push(0);
    const oKeyPad = [];
    const iKeyPad = [];
    for (let i = 0; i < blockSize; i++) {
      oKeyPad.push(keyBytes[i] ^ 0x5c);
      iKeyPad.push(keyBytes[i] ^ 0x36);
    }
    const inner = sha256Bytes(iKeyPad.concat(utf8Bytes(stringInput(msg))));
    return bytesToHex(sha256Bytes(oKeyPad.concat(inner)));
  }

  // ── Deterministic clock / id ───────────────────────────────────────
  // The host injects a fixed per-execution timestamp (`__sandbox_now__`,
  // epoch ms) and a stable seed (`__sandbox_seed__`, e.g. the execution
  // id) as VM globals BEFORE this stdlib runs. `now()` returns the SAME
  // instant for every call in a run, and `uuid()` is a deterministic
  // v4-shaped id derived from the seed plus a per-context call counter —
  // so authors stop reaching for the banned `new Date()` / `Date.now()` /
  // `Math.random()` and the run stays reproducible under self-healing
  // dry-runs.
  //
  // SECURITY: capture the injected values ONCE here at install time into
  // closure consts, then DELETE the writable globals. If we instead read
  // `globalThis.__sandbox_now__` / `__sandbox_seed__` on every call,
  // untrusted user JS could overwrite them between `sk.now()` /
  // `sk.uuid()` calls (`globalThis.__sandbox_now__ = 0`) and corrupt
  // determinism — two calls in the same run would observe different
  // clocks. Captured-then-deleted, the user cannot reach or change them.
  const __CAPTURED_NOW = (function captureNow() {
    const n = globalThis.__sandbox_now__;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  })();
  const __CAPTURED_SEED = (function captureSeed() {
    const s = globalThis.__sandbox_seed__;
    return typeof s === "string" && s.length > 0 ? s : "sk-stdlib";
  })();
  try {
    delete globalThis.__sandbox_now__;
  } catch (_e) {
    /* non-configurable in some hosts — the capture above still wins */
  }
  try {
    delete globalThis.__sandbox_seed__;
  } catch (_e) {
    /* non-configurable in some hosts — the capture above still wins */
  }

  function injectedNow() {
    return __CAPTURED_NOW;
  }

  function injectedSeed() {
    return __CAPTURED_SEED;
  }

  function now() {
    return injectedNow();
  }

  function nowIso() {
    return new Date(injectedNow()).toISOString();
  }

  let __uuidCounter = 0;

  // Deterministic UUIDv4-shaped id: SHA-256 over the seed + a monotonic
  // per-context counter, formatted as a v4 UUID (version nibble `4`,
  // variant bits `10`). Distinct on each call within a run, identical
  // across replays of the same run.
  function uuid() {
    const digest = sha256Bytes(utf8Bytes(`${injectedSeed()}:${String(__uuidCounter)}`));
    __uuidCounter += 1;
    const b = digest.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const hex = bytesToHex(b);
    return (
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-" +
      hex.slice(12, 16) +
      "-" +
      hex.slice(16, 20) +
      "-" +
      hex.slice(20, 32)
    );
  }

  function isString(v) {
    return typeof v === "string";
  }
  function isNumber(v) {
    return typeof v === "number" && !Number.isNaN(v);
  }
  function isArray(v) {
    return Array.isArray(v);
  }
  function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }
  function isNil(v) {
    return v === null || v === undefined;
  }

  const http = Object.freeze({
    isMutating: isMutating,
    isSafe: isSafe,
    METHODS: Object.freeze({
      READ: Object.freeze(READ_METHODS.slice()),
      WRITE: Object.freeze(WRITE_METHODS.slice()),
    }),
  });

  const sk = Object.freeze({
    http: http,
    get: get,
    has: has,
    allow: allow,
    deny: deny,
    pick: pick,
    omit: omit,
    pluck: pluck,
    groupBy: groupBy,
    uniq: uniq,
    base64Encode: base64Encode,
    base64UrlEncode: base64UrlEncode,
    base64EncodeUtf8: base64EncodeUtf8,
    base64UrlEncodeUtf8: base64UrlEncodeUtf8,
    base64Decode: base64Decode,
    base64DecodeUtf8: base64DecodeUtf8,
    hexEncode: hexEncode,
    hexDecode: hexDecode,
    sha256: sha256,
    hmacSha256: hmacSha256,
    now: now,
    nowIso: nowIso,
    uuid: uuid,
    isString: isString,
    isNumber: isNumber,
    isArray: isArray,
    isObject: isObject,
    isNil: isNil,
    version: "1.4.0",
  });

  Object.defineProperty(globalThis, "sk", {
    value: sk,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // Install the universally-known `btoa`/`atob` globals as thin wrappers
  // over the binary-string base64 codec (Web semantics: each char is one
  // byte, low 8 bits). Their absence is a footgun — author code reaches
  // for `btoa` by reflex, fails, and hand-rolls an encoder instead of
  // finding `sk.base64EncodeUtf8` (production session, the Gmail MIME
  // build). For Unicode payloads use `sk.base64EncodeUtf8` /
  // `sk.base64UrlEncodeUtf8`; `btoa` mirrors the browser and throws on
  // code points > 255. Still no host I/O — pure in-sandbox functions.
  Object.defineProperty(globalThis, "btoa", {
    value: function btoa(input) {
      const s = stringInput(input);
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) > 0xff) {
          throw new Error(
            "btoa: string contains a code point > 255 — use sk.base64EncodeUtf8() for Unicode",
          );
        }
      }
      return base64Encode(s);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });

  Object.defineProperty(globalThis, "atob", {
    value: function atob(input) {
      return base64Decode(input);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
