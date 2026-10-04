export interface CurlExtract {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  auth_hint: { type: "bearer" | "basic" | "header" | "none"; header_name?: string } | null;
}

export function parseCurlCommand(raw: string): CurlExtract {
  const tokens = tokenize(raw);
  if (tokens.length === 0 || tokens[0] !== "curl") {
    throw new Error("expected command starting with 'curl'");
  }
  let url = "";
  let method = "GET";
  const headers: Record<string, string> = {};
  let body: string | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "-X" || t === "--request") {
      method = tokens[++i] ?? method;
    } else if (t === "-H" || t === "--header") {
      const h = tokens[++i] ?? "";
      const idx = h.indexOf(":");
      if (idx > 0) {
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
    } else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      body = tokens[++i] ?? null;
      if (method === "GET") method = "POST";
    } else if (t === "-u" || t === "--user") {
      const creds = tokens[++i] ?? "";
      headers.Authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
    } else if (!t.startsWith("-") && !url) {
      url = t.replace(/^["']|["']$/g, "");
    }
  }

  const auth_hint = detectAuth(headers);
  return { url, method: method.toUpperCase(), headers, body, auth_hint };
}

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?:"((?:\\"|[^"])*)"|'([^']*)'|(\S+))/g;
  for (const m of cmd.matchAll(re)) {
    const tok = m[1] ?? m[2] ?? m[3] ?? "";
    out.push(tok.replace(/\\"/g, '"'));
  }
  return out;
}

function detectAuth(headers: Record<string, string>): CurlExtract["auth_hint"] {
  for (const [k, v] of Object.entries(headers)) {
    const kl = k.toLowerCase();
    if (kl === "authorization") {
      if (/^bearer\s/i.test(v)) return { type: "bearer" };
      if (/^basic\s/i.test(v)) return { type: "basic" };
      return { type: "header", header_name: k };
    }
    if (kl.includes("api-key") || kl.includes("apikey") || kl.includes("x-auth-token")) {
      return { type: "header", header_name: k };
    }
  }
  return { type: "none" };
}
