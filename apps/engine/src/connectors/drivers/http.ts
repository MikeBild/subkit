// HTTP driver. Resolves connector + credentials and mutates a request
// descriptor so the caller's fetch() lands with the right Authorization
// header, basic-auth base64, bearer token, or appended query.
//
// The driver is intentionally small — it does NOT re-implement the
// retry, timeout, pagination, or filter logic from the P3 request step.
// Instead, the request step imports `applyAuthToRequest` below to mix
// connector auth into its existing HTTP pipeline.
//
// Auth contract: when auth_type !== "none" and no credential row exists,
// the driver surfaces a structured credential_required error rather than
// sending an unauthenticated request. Callers must persist a credential
// via save_connector_draft({credential}) before probing.

import { refreshIfStale } from "../../credentials/oauth2/refresh-worker.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { tunnelRegistry } from "../../tunnels/registry.ts";
import type { TunnelResponse } from "../../tunnels/types.ts";
import { injectTraceContext, scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import { getConnectorProbeEndpoint } from "../template-binding.ts";
import type { ConnectorView } from "../types.ts";
import { signSigV4Request } from "./aws-sigv4.ts";

// Re-export so callers that already import from this driver can catch
// the SSRF-block error without taking a direct dependency on the guard.
export { EgressBlockedError } from "../egress-guard.ts";

export interface HttpRequestDescriptor {
  base_url: string | null;
  path_or_url: string; // either an absolute URL or a path relative to base_url
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
}

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Resolve the final URL for a request relative to a connector's
 * base_url. If the input already absolute, the base_url is ignored.
 */
export function resolveUrl(base_url: string | null, path_or_url: string): URL {
  if (isAbsoluteUrl(path_or_url)) return new URL(path_or_url);
  const base = base_url ?? "";
  if (!base) {
    throw new Error(
      `HTTP driver: no base_url on connector and path "${path_or_url}" is not absolute`,
    );
  }
  // new URL(path, base) — URL normalises leading slashes for us.
  return new URL(path_or_url, base.endsWith("/") ? base : `${base}/`);
}

/**
 * Mutate a header/query bag according to the credential's auth mode.
 * Header/query values authored on the connector (`config.static_headers`,
 * `config.static_query`) land on the request too.
 */
export function applyAuthMaterial(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean>,
): void {
  const cfg = (connector.config ?? {}) as {
    static_headers?: Record<string, string>;
    static_query?: Record<string, string>;
  };
  if (cfg.static_headers) {
    for (const [k, v] of Object.entries(cfg.static_headers)) {
      headers[k] = v;
    }
  }
  if (cfg.static_query) {
    for (const [k, v] of Object.entries(cfg.static_query)) {
      query[k] = v;
    }
  }
  if (!credential) {
    // No credential row — static headers/query still apply, but auth
    // material cannot be injected. Callers that require auth must gate
    // on credential_required before reaching here (see probeHttpConnector).
    return;
  }
  switch (credential.mode) {
    case "none":
      return;
    case "header":
      for (const [k, v] of Object.entries(credential.headers)) {
        headers[k] = v;
      }
      return;
    case "query":
      for (const [k, v] of Object.entries(credential.query)) {
        query[k] = v;
      }
      return;
    case "bearer":
      headers.Authorization = `Bearer ${credential.token}`;
      return;
    case "basic": {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${encoded}`;
      return;
    }
    case "aws_sigv4":
      // SigV4 needs the URL + method + body to compute the canonical
      // request — we can't sign here. The dispatch path
      // (`executePlannedHttpRequest`) checks the credential mode and
      // calls `signSigV4Request` right before fetch. This branch is a
      // no-op so the switch stays exhaustive.
      return;
    case "oauth2": {
      // `token_type` controls the Authorization scheme.
      //
      // - "Bearer" (RFC 6750) is the common case — Linear, GitHub, Monday,
      //   Auth0, Cognito client-credentials.
      // - Empty / null / "none" / "no_prefix" → emit the token VERBATIM
      //   without a scheme prefix. Required by AppSync Cognito User-Pool
      //   auth and Lambda authorizer flows that expect the raw JWT
      //   (`Authorization: eyJ…`), and tolerant of IdPs that return
      //   `token_type: ""`.
      const scheme = (credential.token_type ?? "").trim();
      const rawScheme = scheme === "" || /^(none|no_prefix)$/i.test(scheme);
      headers.Authorization = rawScheme
        ? credential.access_token
        : `${scheme} ${credential.access_token}`;
      return;
    }
  }
}

export interface ResolveConnectorRequestParams {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  /** Skip the `connector_credentials` lookup and use this credential
   *  verbatim. Used by `probe_connector_draft` to inject the
   *  in-memory draft credential before the connector has been
   *  persisted (no UUID-keyed row exists yet). Never use this for
   *  saved-connector traffic — go through `getCredentialForConnector`
   *  so audit, rotation, and OAuth refresh stay observable. */
  credential_override?: DecryptedCredential | null;
  /** Outbound idempotency key. When set the resolved plan injects an
   *  `Idempotency-Key` header so retried writes against remotes that honour
   *  the standard don't double-apply. Caller owns the key shape — the
   *  request step uses `${execution_id}:${step_id}:${attempt}` so each
   *  retry is a distinct key tracing back to a concrete attempt. GET /
   *  HEAD / OPTIONS callers should leave this unset. */
  idempotency_key?: string;
}

/** What auth was actually applied — observable at request time.
 *  `oauth2_refreshed` means a stale token was rotated inline before this
 *  request went out; `oauth2_static` means the cached token was still
 *  fresh. Debuggers can spot a token-rotation hiccup this way. */
export type AppliedAuthMethod =
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed"
  | "aws_sigv4";

export interface ResolvedConnectorCredential {
  credential: DecryptedCredential | null;
  credential_id: string | null;
  /** True when the oauth2 path rotated a stale token inline. Always
   *  false for non-oauth2 modes. */
  oauth2_refreshed: boolean;
}

/**
 * Shared credential resolver for any driver that uses connector auth.
 * Pulls the persisted credential row, decrypts it, and runs the inline
 * oauth2 refresh path if the token is near expiry. Drivers should use
 * this instead of calling `getCredentialForConnector` directly so
 * GraphQL / S3 / future drivers get the same refresh-on-stale guarantees
 * the HTTP driver has.
 *
 * The `override` parameter mirrors `buildRequestPlan`'s
 * `credential_override` slot — used by `probe_connector_draft` to test
 * pre-persist drafts.
 */
export async function resolveConnectorCredential(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  override?: DecryptedCredential | null;
}): Promise<ResolvedConnectorCredential> {
  if (p.override !== undefined) {
    return { credential: p.override, credential_id: null, oauth2_refreshed: false };
  }
  if (p.connector.auth_type === "none") {
    return { credential: null, credential_id: null, oauth2_refreshed: false };
  }
  const row = await getCredentialForConnector(
    p.tenant_id,
    p.connector.id,
    p.connector.environment,
    p.db,
  );
  if (!row) {
    return { credential: null, credential_id: null, oauth2_refreshed: false };
  }
  let credential: DecryptedCredential = row.value;
  let oauth2_refreshed = false;
  if (credential.mode === "oauth2") {
    const preToken = credential.access_token;
    credential = await refreshIfStale(p.db, p.tenant_id, row.row, credential);
    if (credential.mode === "oauth2" && credential.access_token !== preToken) {
      oauth2_refreshed = true;
    }
  }
  return { credential, credential_id: row.row.id, oauth2_refreshed };
}

/** Map a `DecryptedCredential` + the oauth2-refresh observation into the
 *  observable `AppliedAuthMethod`. Shared by HTTP, GraphQL, and any
 *  future driver. */
export function deriveAppliedAuthMethod(
  credential: DecryptedCredential | null,
  oauth2Refreshed: boolean,
): AppliedAuthMethod {
  if (!credential) return "none";
  switch (credential.mode) {
    case "none":
      return "none";
    case "bearer":
      return "bearer";
    case "header":
      return "header";
    case "query":
      return "query";
    case "basic":
      return "basic";
    case "oauth2":
      return oauth2Refreshed ? "oauth2_refreshed" : "oauth2_static";
    case "aws_sigv4":
      return "aws_sigv4";
  }
}

export interface ResolvedRequestPlan {
  url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  credential: DecryptedCredential | null;
  /** The credential row id, when a stored credential was used. Surfaces
   *  through to the egress audit (`CREDENTIAL_ACCESSED`) so an operator
   *  can answer "which credential was used for this request?" without
   *  re-running the lookup. */
  credential_id: string | null;
  auth_method: AppliedAuthMethod;
  // When set, the request step should forward this request through the
  // named tunnel target instead of doing a direct `fetch`. The value is
  // the target name registered by the agent during the register frame.
  tunnel_target?: string;
}

/**
 * One-shot: pull the connector's credential, apply it, and return a
 * ready-to-fetch plan. Used both by the request step runner and by the
 * connector.test route.
 */
export async function buildRequestPlan(
  p: ResolveConnectorRequestParams,
): Promise<ResolvedRequestPlan> {
  const headers = { ...(p.headers ?? {}) };
  const query = { ...(p.query ?? {}) };
  const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
  };
  if (p.credential_override !== undefined) {
    resolveOpts.override = p.credential_override;
  }
  const {
    credential,
    credential_id: credentialId,
    oauth2_refreshed: oauth2Refreshed,
  } = await resolveConnectorCredential(resolveOpts);
  applyAuthMaterial(p.connector, credential, headers, query);
  // Idempotency-Key — opt-in per-call, set by the request step for
  // non-idempotent methods. Pass-through; the value is plain text and is
  // not scrubbed by the egress audit (it's not a credential).
  if (p.idempotency_key) {
    headers["Idempotency-Key"] = p.idempotency_key;
  }
  const url = resolveUrl(p.connector.base_url, p.path_or_url);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const cfg = (p.connector.config ?? {}) as { tunnel_target?: unknown };
  const plan: ResolvedRequestPlan = {
    url,
    headers,
    query,
    credential,
    credential_id: credentialId,
    auth_method: deriveAppliedAuthMethod(credential, oauth2Refreshed),
  };
  if (typeof cfg.tunnel_target === "string" && cfg.tunnel_target.length > 0) {
    plan.tunnel_target = cfg.tunnel_target;
  }
  // SSRF guard: block private/loopback/link-local targets unless the
  // operator authorised the path via a registered tunnel. Must run AFTER
  // tunnel_target is resolved so the tunnel exemption kicks in.
  assertEgressAllowed(url, {
    tenant_id: p.tenant_id,
    tunnel_target: plan.tunnel_target ?? null,
  });
  log.connector.request.planned({
    connector_id: p.connector.id,
    auth_type: p.connector.auth_type,
    url_host: url.host,
    url: scrubUrl(url),
    has_credential: credential !== null,
    oauth2_refreshed: oauth2Refreshed,
    tunnel_target: plan.tunnel_target ?? null,
  });
  return plan;
}

export interface HttpExecutionResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  url: string;
  tunnel_target?: string;
}

/**
 * Decide whether the Content-Type header is informative or not.
 * Servers that return JSON with `application/octet-stream`,
 * `text/plain`, or no header at all are common enough that we'd
 * rather sniff than mis-parse. The trusted-header path stays the
 * fast path: if the header explicitly says `application/json`,
 * `text/csv`, or any well-known text variant, we honour it without
 * inspecting body bytes.
 */
function shouldSniff(contentType: string): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (ct.includes("application/octet-stream")) return true;
  if (ct === "text/plain" || ct.startsWith("text/plain;")) return true;
  return false;
}

/**
 * Body content sniffer — reads the first ~512 bytes and decides
 * whether the payload looks like JSON, XML, or CSV. Keep the
 * heuristics conservative (`{` or `[` for JSON; `<?xml`/`<root>` for
 * XML; comma-delimited header line for CSV) so we never mis-classify
 * arbitrary text. Returns `null` when no shape matches; caller falls
 * back to the raw text.
 */
function sniffBodyShape(text: string): "json" | "xml" | "csv" | null {
  const sample = text.slice(0, 512).trimStart();
  if (!sample) return null;
  if (sample.startsWith("{") || sample.startsWith("[")) return "json";
  if (sample.startsWith("<?xml") || /^<[a-z_][\w:.-]*[\s>]/i.test(sample)) return "xml";
  // CSV heuristic: header line is a comma-delimited list of identifier-
  // ish tokens (no internal spaces) AND the body has at least one
  // additional row. Requiring identifier-shaped header cells avoids
  // false positives on prose ("just some prose, nothing structured" —
  // both cells contain spaces).
  const lines = sample.split(/\r?\n/);
  if (lines.length >= 2) {
    const header = lines[0] ?? "";
    if (header.includes(",")) {
      const cells = header.split(",");
      const looksLikeIdentifierHeader =
        cells.length >= 2 && cells.every((c) => /^[A-Za-z_][\w\-.]{0,63}$/.test(c.trim()));
      const secondLineHasContent = (lines[1] ?? "").trim().length > 0;
      if (looksLikeIdentifierHeader && secondLineHasContent) return "csv";
    }
  }
  return null;
}

/** @internal Exported for unit tests; do not import outside http.ts. */
export function parseResponseBody(text: string, contentType: string): unknown {
  // Trusted-header fast path. JSON is the overwhelming majority of
  // responses we see; honour the header without sniffing.
  if (contentType.includes("application/json") && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Magic-byte sniff for headers that don't disclose the real shape
  // (octet-stream, text/plain, missing). Returning the parsed JSON /
  // CSV row array here lets a downstream `data_selector` work even
  // when the vendor didn't set Content-Type properly.
  if (shouldSniff(contentType) && text.length > 0) {
    const shape = sniffBodyShape(text);
    if (shape === "json") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (shape === "csv") {
      return parseCsvBody(text);
    }
    if (shape === "xml") {
      const parsed = parseXmlBody(text);
      if (parsed !== null) return parsed;
      // Fall through to raw text on malformed XML.
    }
  }
  return text;
}

/**
 * Tiny tag-soup XML parser. Handles enough of XML 1.0 + namespaces to
 * convert SOAP / XML-RPC / RSS responses into a JSONata-friendly tree:
 *
 *   <root xmlns:ns="…"><a id="1">x</a><a id="2">y</a></root>
 *     →  { "root": { "a": [ { "@id": "1", "#text": "x" },
 *                            { "@id": "2", "#text": "y" } ] } }
 *
 * Conventions:
 *   - Attributes are prefixed `@` so they sit alongside element
 *     children without colliding with element names.
 *   - Repeated child elements collapse to an array (the typical
 *     vendor convention; single-child cases stay as an object).
 *   - Text content lives at `#text` so a node with both attributes
 *     and text reads cleanly.
 *   - Namespace prefixes (`ns:tag`) keep the prefix in the key so
 *     authors can address them without inventing local-name munging.
 *   - Self-closing tags become `null`.
 *   - CDATA segments are concatenated into `#text` verbatim.
 *
 * Returns `null` on any parse failure so the caller falls back to the
 * raw text.
 */
/**
 * Serialize a structured value back into XML using the same
 * conventions the parser produces. `@attr` keys become attributes,
 * `#text` becomes text content, arrays become repeated elements.
 * Unknown values stringify via `String(value)`. Used for symmetric
 * `xml: { … }` request bodies — operators can build the same tree
 * shape they consume.
 */
export function serializeXmlBody(value: unknown): string {
  const escapeText = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeAttr = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const renderNode = (name: string, node: unknown): string => {
    if (node === null || node === undefined) return `<${name}/>`;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      return `<${name}>${escapeText(String(node))}</${name}>`;
    }
    if (Array.isArray(node)) {
      return node.map((entry) => renderNode(name, entry)).join("");
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const attrs: string[] = [];
      const children: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("@")) {
          attrs.push(`${k.slice(1)}="${escapeAttr(String(v ?? ""))}"`);
        } else if (k === "#text") {
          children.push(escapeText(String(v ?? "")));
        } else {
          children.push(renderNode(k, v));
        }
      }
      const head = attrs.length > 0 ? `${name} ${attrs.join(" ")}` : name;
      if (children.length === 0) return `<${head}/>`;
      return `<${head}>${children.join("")}</${name}>`;
    }
    return `<${name}>${escapeText(String(node))}</${name}>`;
  };
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" || Array.isArray(value)) {
    return renderNode("root", value);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [name, child] = entries[0]!;
    return renderNode(name, child);
  }
  return renderNode("root", value);
}

function parseXmlBody(text: string): unknown {
  try {
    type XmlNode = string | { [k: string]: unknown };
    let i = 0;
    const len = text.length;
    // Active namespace bindings stack — each frame is the prefix→URI
    // map in scope at that depth. Pushed on element entry, popped on
    // element exit. A `null` URI means "no namespace" (default
    // namespace removed).
    const nsStack: Array<Record<string, string>> = [{}];

    const currentBindings = (): Record<string, string> => Object.assign({}, ...nsStack);

    const resolveNs = (qname: string): { prefix: string; local: string; uri: string | null } => {
      const idx = qname.indexOf(":");
      if (idx < 0) {
        const bindings = currentBindings();
        return { prefix: "", local: qname, uri: bindings[""] ?? null };
      }
      const prefix = qname.slice(0, idx);
      const local = qname.slice(idx + 1);
      const bindings = currentBindings();
      return { prefix, local, uri: bindings[prefix] ?? null };
    };

    const skipWhitespace = (): void => {
      while (i < len) {
        const ch = text[i]!;
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") i++;
        else break;
      }
    };

    // Drop XML declaration, DOCTYPE, comments, processing instructions.
    const consumeProlog = (): void => {
      while (i < len) {
        skipWhitespace();
        if (text.startsWith("<?", i)) {
          const end = text.indexOf("?>", i + 2);
          if (end < 0) break;
          i = end + 2;
          continue;
        }
        if (text.startsWith("<!--", i)) {
          const end = text.indexOf("-->", i + 4);
          if (end < 0) break;
          i = end + 3;
          continue;
        }
        if (text.startsWith("<!DOCTYPE", i) || text.startsWith("<!doctype", i)) {
          const end = text.indexOf(">", i);
          if (end < 0) break;
          i = end + 1;
          continue;
        }
        break;
      }
    };

    const decodeEntities = (s: string): string =>
      s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");

    const parseAttrs = (raw: string): Record<string, string> => {
      const attrs: Record<string, string> = {};
      const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
        attrs[`@${m[1]}`] = decodeEntities(m[2] ?? m[3] ?? "");
      }
      return attrs;
    };

    const parseElement = (): { name: string; node: XmlNode } | null => {
      if (text[i] !== "<") return null;
      const tagEnd = text.indexOf(">", i);
      if (tagEnd < 0) return null;
      const tagBody = text.slice(i + 1, tagEnd).trim();
      const selfClosing = tagBody.endsWith("/");
      const inner = selfClosing ? tagBody.slice(0, -1).trim() : tagBody;
      const spaceIdx = inner.search(/\s/);
      const rawName = spaceIdx < 0 ? inner : inner.slice(0, spaceIdx);
      const attrPart = spaceIdx < 0 ? "" : inner.slice(spaceIdx + 1);
      const rawAttrs = parseAttrs(attrPart);

      // Pull xmlns declarations out of the attribute set + push a new
      // namespace frame so child elements resolve through the right
      // bindings. The xmlns bindings still surface on the resulting
      // node (as @xmlns:* attrs) for round-trip transparency, but
      // resolveNs() answers about URIs, not just prefixes.
      const newBindings: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawAttrs)) {
        if (k === "@xmlns") {
          newBindings[""] = v;
        } else if (k.startsWith("@xmlns:")) {
          newBindings[k.slice("@xmlns:".length)] = v;
        }
      }
      nsStack.push(newBindings);

      const resolved = resolveNs(rawName);
      // The rendered key uses the local name when a default namespace
      // is in scope (so `<foo xmlns="urn:bar"><baz/></foo>` renders as
      // `{ foo: { baz: null } }` rather than carrying a synthetic
      // prefix). When a prefix is present, keep the prefixed form so
      // authors can still address it; the resolved URI surfaces under
      // a synthetic `@xmlns:_resolved` attribute when prefixes from
      // different scopes share a local name. The collision case is
      // when the document itself overloads `prefix:tag` from disjoint
      // URIs in sibling subtrees — rare in practice; we handle the
      // common SOAP / RSS / XHTML case correctly.
      const name = resolved.prefix ? rawName : resolved.local;
      i = tagEnd + 1;

      // Translate attributes: map `@a` (an attribute) to `@@a` when
      // the parent will also have a child named `a`. We can't know
      // ahead of time, so eagerly use `@@` for ALL attributes that
      // collide with a known reserved child name (handled below at
      // child-merge time). For now keep them as parsed (`@a`).
      if (selfClosing) {
        nsStack.pop();
        const node =
          Object.keys(rawAttrs).length > 0
            ? (rawAttrs as Record<string, unknown>)
            : (null as unknown as XmlNode);
        return { name, node };
      }
      // Collect children + text until the matching close tag.
      const children: Record<string, unknown> = { ...rawAttrs };
      let textBuf = "";
      let closed = false;
      while (i < len) {
        if (text.startsWith("</", i)) {
          const end = text.indexOf(">", i + 2);
          if (end < 0) return null;
          i = end + 1;
          closed = true;
          break;
        }
        if (text.startsWith("<![CDATA[", i)) {
          const end = text.indexOf("]]>", i + 9);
          if (end < 0) return null;
          textBuf += text.slice(i + 9, end);
          i = end + 3;
          continue;
        }
        if (text.startsWith("<!--", i)) {
          const end = text.indexOf("-->", i + 4);
          if (end < 0) return null;
          i = end + 3;
          continue;
        }
        if (text[i] === "<") {
          const child = parseElement();
          if (!child) return null;
          // Collision-avoidance: if an attribute exists at @name and a
          // child element shares the local name, rewrite the attribute
          // key to @@name so the operator can disambiguate. The double-
          // @ is parser-internal escape — `serializeXmlBody` reads it
          // back as a single attribute name on round-trip.
          const collidingAttr = `@${child.name}`;
          if (collidingAttr in children) {
            children[`@@${child.name}`] = children[collidingAttr];
            delete children[collidingAttr];
          }
          const existing = children[child.name];
          if (existing === undefined) {
            children[child.name] = child.node;
          } else if (Array.isArray(existing)) {
            existing.push(child.node);
          } else {
            children[child.name] = [existing, child.node];
          }
        } else {
          const next = text.indexOf("<", i);
          textBuf += text.slice(i, next < 0 ? len : next);
          i = next < 0 ? len : next;
        }
      }
      if (!closed) {
        nsStack.pop();
        return null;
      }
      nsStack.pop();
      const trimmed = decodeEntities(textBuf).trim();
      if (Object.keys(children).length === 0) {
        return { name, node: trimmed };
      }
      if (trimmed.length > 0) children["#text"] = trimmed;
      return { name, node: children };
    };

    consumeProlog();
    if (i >= len || text[i] !== "<") return null;
    const root = parseElement();
    if (!root) return null;
    return { [root.name]: root.node };
  } catch {
    return null;
  }
}

/**
 * Tiny RFC-4180-ish CSV parser. Handles double-quoted fields with
 * embedded commas + escaped double-quotes; trims the trailing newline.
 * The first row is treated as a header; downstream rows render as
 * objects keyed by header name. Returns an empty array on any parse
 * failure rather than throwing — the caller can fall back to text.
 */
function parseCsvBody(text: string): Array<Record<string, string>> {
  try {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          cur.push(field);
          field = "";
        } else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          cur.push(field);
          rows.push(cur);
          cur = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || cur.length > 0) {
      cur.push(field);
      rows.push(cur);
    }
    if (rows.length === 0) return [];
    const header = rows[0]!;
    return rows.slice(1).map((cells) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        obj[header[i]!] = cells[i] ?? "";
      }
      return obj;
    });
  } catch {
    return [];
  }
}

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export async function executePlannedHttpRequest(params: {
  tenant_id: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  tunnel_target?: string;
  /** When set, the dispatch path runs SigV4 signing right before
   *  `fetch` — sigv4 needs the URL + method + body to compute the
   *  canonical request, so it can't run earlier. */
  sigv4?: {
    region: string;
    service: string;
    credential: import("../../credentials/types.ts").AwsSigV4CredentialValue;
  };
}): Promise<HttpExecutionResult> {
  if (params.tunnel_target) {
    const effectiveBody =
      params.body !== undefined && params.body !== null && params.method !== "GET"
        ? typeof params.body === "string"
          ? params.body
          : JSON.stringify(params.body)
        : null;
    const headers = { ...params.headers };
    if (effectiveBody !== null && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    injectTraceContext(headers);
    const tunnelRes = await fetchViaTunnel({
      tenant_id: params.tenant_id,
      tunnel_target: params.tunnel_target,
      method: params.method,
      url: params.url,
      headers,
      body: effectiveBody,
    });
    const text = tunnelRes.body ?? "";
    const contentType =
      tunnelRes.headers["content-type"] ?? tunnelRes.headers["Content-Type"] ?? "";
    return {
      status: tunnelRes.status,
      headers: tunnelRes.headers,
      body: parseResponseBody(text, contentType),
      bytes_in: Buffer.byteLength(text, "utf8"),
      url: params.url.toString(),
      tunnel_target: params.tunnel_target,
    };
  }

  const headers = { ...params.headers };
  const init: RequestInit = {
    method: params.method,
    headers,
    signal: params.signal,
  };
  if (
    params.body !== undefined &&
    params.body !== null &&
    params.method !== "GET" &&
    params.method !== "HEAD"
  ) {
    init.body = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }
  injectTraceContext(headers);
  // SigV4 must run AFTER content-type / trace headers are stamped (they
  // contribute to the canonical-headers hash) and BEFORE fetch.
  if (params.sigv4) {
    signSigV4Request({
      method: params.method,
      url: params.url,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      region: params.sigv4.region,
      service: params.sigv4.service,
      credential: params.sigv4.credential,
    });
  }
  const res = await fetch(params.url, init);
  const text = await res.text();
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });
  return {
    status: res.status,
    headers: headerObj,
    body: parseResponseBody(text, res.headers.get("content-type") ?? ""),
    bytes_in: Buffer.byteLength(text, "utf8"),
    url: params.url.toString(),
    ...(params.tunnel_target ? { tunnel_target: params.tunnel_target } : {}),
  };
}

export async function executeConnectorHttpRequest(params: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: string;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  signal?: AbortSignal;
  timeout_ms?: number;
  credential_override?: DecryptedCredential | null;
  idempotency_key?: string;
}): Promise<HttpExecutionResult> {
  const planArgs: ResolveConnectorRequestParams = {
    db: params.db,
    tenant_id: params.tenant_id,
    connector: params.connector,
    path_or_url: params.path_or_url,
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.query ? { query: params.query } : {}),
    ...(params.credential_override ? { credential_override: params.credential_override } : {}),
    ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
  };
  const plan = await buildRequestPlan(planArgs);
  const signals: AbortSignal[] = [];
  if (params.signal) signals.push(params.signal);
  let timeoutSignal: AbortSignal | null = null;
  if (params.timeout_ms !== undefined) {
    timeoutSignal = AbortSignal.timeout(params.timeout_ms);
    signals.push(timeoutSignal);
  }
  const signal =
    signals.length === 0
      ? AbortSignal.timeout(60_000)
      : signals.length === 1
        ? signals[0]!
        : mergeSignals(signals);

  // SigV4 connector → derive the signer from the resolved credential
  // and the connector config (`aws_region`, `aws_service`).
  let sigv4Args: Parameters<typeof executePlannedHttpRequest>[0]["sigv4"] | undefined;
  if (plan.credential?.mode === "aws_sigv4") {
    const cfg = (params.connector.config ?? {}) as {
      aws_region?: unknown;
      aws_service?: unknown;
    };
    const region = typeof cfg.aws_region === "string" ? cfg.aws_region : "us-east-1";
    const service = typeof cfg.aws_service === "string" ? cfg.aws_service : null;
    if (!service) {
      throw new Error(
        `aws_sigv4 connector ${params.connector.id} missing required config.aws_service`,
      );
    }
    sigv4Args = { region, service, credential: plan.credential };
  }

  return await executePlannedHttpRequest({
    tenant_id: params.tenant_id,
    method: params.method,
    url: plan.url,
    headers: plan.headers,
    body: params.body,
    signal,
    ...(plan.tunnel_target ? { tunnel_target: plan.tunnel_target } : {}),
    ...(sigv4Args ? { sigv4: sigv4Args } : {}),
  });
}

/**
 * Forward a fully-prepared HTTP request through a registered tunnel.
 * The caller is expected to have built `plan.headers` + `plan.url` via
 * `buildRequestPlan`, so credentials are already injected. The agent
 * just relays the request against its local target.
 */
export async function fetchViaTunnel(params: {
  tenant_id: string;
  tunnel_target: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}): Promise<TunnelResponse> {
  const pathAndQuery = `${params.url.pathname}${params.url.search}`;
  const opts: { timeoutMs?: number } = {};
  if (params.timeoutMs !== undefined) opts.timeoutMs = params.timeoutMs;
  return await tunnelRegistry.forwardRequest(
    params.tenant_id,
    params.tunnel_target,
    {
      target: params.tunnel_target,
      method: params.method,
      path: pathAndQuery,
      headers: params.headers,
      body: params.body ?? null,
    },
    opts,
  );
}

export interface HttpProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  // When true the probe is advisory only — callers should not block on it.
  warning_only: boolean;
  warnings: Array<{ code: string; message: string }>;
}

// Shape stored in connector.config.probe_endpoint (mirrors ProbeEndpointSchema).
interface ProbeEndpointConfig {
  method: "GET" | "HEAD" | "POST";
  path: string;
  expected_status: [number, number];
  description: string;
}

function isProbeEndpointConfig(v: unknown): v is ProbeEndpointConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.path === "string" && Array.isArray(c.expected_status) && c.expected_status.length === 2
  );
}

/**
 * Health probe: do a minimal request against the connector's base_url,
 * respecting `connector.config.probe_endpoint` when present.
 * Falls back to GET / and marks the result warning_only when the
 * fallback returns 404 or 405.
 */
export async function probeHttpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  try {
    if (!p.connector.base_url) {
      return {
        ok: false,
        latency_ms: 0,
        detail: "connector has no base_url",
        warning_only: false,
        warnings: [],
      };
    }

    // Guard: auth-required connectors must have a persisted credential row.
    // Without one the request would go out unauthenticated and 401/404 in a
    // way that is indistinguishable from a genuine connectivity failure.
    if (p.connector.auth_type !== "none") {
      const credRow = await getCredentialForConnector(
        p.tenant_id,
        p.connector.id,
        p.connector.environment,
        p.db,
      );
      if (!credRow) {
        return {
          ok: false,
          latency_ms: 0,
          detail:
            "credential_required: probe requires a saved credential — collect one via ask_user_form and persist via save_connector_draft({credential})",
          warning_only: false,
          warnings: [
            {
              code: "CREDENTIAL_REQUIRED",
              message: "draft has no attached credential; cannot probe",
            },
          ],
        };
      }
    }

    const rawProbe = getConnectorProbeEndpoint(p.connector);
    const probeConfig = isProbeEndpointConfig(rawProbe) ? rawProbe : null;

    const method = probeConfig?.method ?? "GET";
    // Empty path means probe the base_url directly (no path segment appended).
    const pathOrUrl = probeConfig !== null && probeConfig.path !== "" ? probeConfig.path : "/";

    const res = await executeConnectorHttpRequest({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method,
      path_or_url: pathOrUrl,
    });

    const latency_ms = Date.now() - start;
    const warnings: Array<{ code: string; message: string }> = [];
    let ok: boolean;
    let warning_only = false;

    if (probeConfig !== null) {
      // Explicit probe: success iff status is within the declared range.
      const [lo, hi] = probeConfig.expected_status;
      ok = res.status >= lo && res.status <= hi;
    } else {
      // Fallback probe: 404/405 from "GET /" is ambiguous — the service may
      // simply not expose that path, not a connectivity failure.
      if (res.status === 404 || res.status === 405) {
        ok = true;
        warning_only = true;
        warnings.push({
          code: "PROBE_AMBIGUOUS",
          message: `Fallback probe GET / returned ${res.status}; connectivity likely OK but endpoint unknown.`,
        });
      } else {
        ok = res.status < 500;
      }
    }

    const result: HttpProbeResult = { ok, latency_ms, status: res.status, warning_only, warnings };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms,
      status: res.status,
    });
    return result;
  } catch (err) {
    const result: HttpProbeResult = {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      warning_only: false,
      warnings: [],
    };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms: result.latency_ms,
      detail: result.detail,
    });
    return result;
  }
}
