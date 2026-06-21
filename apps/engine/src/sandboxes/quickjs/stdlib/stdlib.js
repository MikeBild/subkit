// sk-Stdlib v1 — curated helper surface for user-supplied JavaScript
// running inside the QuickJS sandbox (before-request hooks,
// transform steps with language: "javascript").
//
// Injected via `context.evalCode(STDLIB_SOURCE, "sk-stdlib.js")` in
// runtime.ts before the user's code runs. Installs `globalThis.sk`
// and freezes it so user code cannot mutate or replace the surface.
//
// Determinism: no Date.now, no Math.random, no host I/O.
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
    table["_"] = 63; // url-safe `/`
    return table;
  })();

  function base64ToBytes(input) {
    const str = stringInput(input).replace(/[\s=]/g, "");
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < str.length; i++) {
      const v = B64_LOOKUP[str[i]];
      if (v === undefined) throw new Error("base64Decode: invalid character at index " + i);
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
    isString: isString,
    isNumber: isNumber,
    isArray: isArray,
    isObject: isObject,
    isNil: isNil,
    version: "1.3.0",
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
