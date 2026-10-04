import { importPKCS8, SignJWT } from "jose";

export interface GoogleAuthOptions {
  clientEmail: string;
  privateKeyPem?: string;
  staticAssertion?: string;
  tokenEndpoint: string;
  scope?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

export class GoogleAuth {
  private cached: CachedToken | null = null;
  readonly opts: GoogleAuthOptions;
  fetchCount = 0;

  constructor(opts: GoogleAuthOptions) {
    this.opts = opts;
  }

  private async buildAssertion(): Promise<string> {
    if (this.opts.staticAssertion) return this.opts.staticAssertion;
    if (!this.opts.privateKeyPem) {
      throw new Error("google auth: privateKeyPem or staticAssertion required");
    }
    const key = await importPKCS8(this.opts.privateKeyPem, "RS256");
    const scope = this.opts.scope ?? "https://www.googleapis.com/auth/chat.bot";
    const nowSec = Math.floor((this.opts.now ?? Date.now)() / 1000);
    return await new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.opts.clientEmail)
      .setSubject(this.opts.clientEmail)
      .setAudience(this.opts.tokenEndpoint)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(key);
  }

  async getAccessToken(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && this.cached.expires_at - 60_000 > now) {
      return this.cached.access_token;
    }
    const assertion = await this.buildAssertion();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.opts.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`google token fetch failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.fetchCount += 1;
    this.cached = {
      access_token: json.access_token,
      expires_at: now + json.expires_in * 1000,
    };
    return this.cached.access_token;
  }

  reset(): void {
    this.cached = null;
    this.fetchCount = 0;
  }
}
