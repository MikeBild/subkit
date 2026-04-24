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
    isString: isString,
    isNumber: isNumber,
    isArray: isArray,
    isObject: isObject,
    isNil: isNil,
    version: "1.0.0",
  });

  Object.defineProperty(globalThis, "sk", {
    value: sk,
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
