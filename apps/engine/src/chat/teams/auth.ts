export interface TeamsAuthOptions {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  scope?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

export class TeamsAuth {
  private cached: CachedToken | null = null;
  readonly opts: TeamsAuthOptions;
  fetchCount = 0;

  constructor(opts: TeamsAuthOptions) {
    this.opts = opts;
  }

  async getAccessToken(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && this.cached.expires_at - 60_000 > now) {
      return this.cached.access_token;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.opts.scope ?? "https://api.botframework.com/.default",
    });
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.opts.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`teams token fetch failed: ${res.status}`);
    }
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
