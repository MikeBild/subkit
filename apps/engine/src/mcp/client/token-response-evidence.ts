import { createHash } from "node:crypto";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  identityFromTokenResponse,
  type VerifiedProviderIdentity,
} from "../../credentials/index.ts";

export class OAuthTokenEvidence {
  private tokenEndpoint: string | null = null;
  private tokenRequestEndpoint: string | null = null;
  private readonly tokenResponseIdentities = new Map<
    string,
    { identity: VerifiedProviderIdentity | null; generation: number | undefined } | null
  >();
  private tokenResponseCapacityReached = false;

  constructor(private readonly issuer: string | undefined) {}

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.tokenEndpoint = null;
    this.tokenRequestEndpoint = null;
    const metadata = state.authorizationServerMetadata;
    try {
      const endpoint = metadata?.token_endpoint
        ? new URL(metadata.token_endpoint)
        : new URL("/token", state.authorizationServerUrl);
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        !["https:", "http:"].includes(endpoint.protocol)
      )
        return;
      this.tokenRequestEndpoint = endpoint.href;
      if (!this.issuer || !metadata?.issuer || !metadata.token_endpoint) return;
      const issuer = new URL(this.issuer);
      if (
        new URL(state.authorizationServerUrl).href !== issuer.href ||
        new URL(metadata.issuer).href !== issuer.href ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        !["https:", "http:"].includes(endpoint.protocol)
      )
        return;
      this.tokenEndpoint = endpoint.href;
    } catch {
      return;
    }
  }

  isTokenRequest(target: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
    if (!this.tokenRequestEndpoint) return false;
    const request = target instanceof Request ? target : null;
    return (
      (init?.method ?? request?.method ?? "GET").toUpperCase() === "POST" &&
      new URL(request?.url ?? String(target)).href === this.tokenRequestEndpoint
    );
  }

  async observeResponse(
    target: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    response: Response,
    generation: number | undefined,
  ): Promise<void> {
    if (!this.tokenEndpoint || !this.issuer || this.tokenResponseCapacityReached || !response.ok)
      return;
    const request = target instanceof Request ? target : null;
    const url = new URL(request?.url ?? String(target)).href;
    if (
      (init?.method ?? request?.method ?? "GET").toUpperCase() !== "POST" ||
      url !== this.tokenEndpoint
    )
      return;
    if (response.url && response.url !== this.tokenEndpoint) {
      this.tokenResponseCapacityReached = true;
      this.tokenResponseIdentities.clear();
      return;
    }
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    let body: unknown;
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 65_536) {
          this.tokenResponseCapacityReached = true;
          this.tokenResponseIdentities.clear();
          void reader.cancel().catch(() => {});
          return;
        }
        chunks.push(part.value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return;
    } finally {
      reader.releaseLock();
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !body.access_token
    )
      return;
    const key = createHash("sha256").update(body.access_token).digest("hex");
    const captured = {
      identity: identityFromTokenResponse(this.issuer, body),
      generation,
    };
    if (this.tokenResponseIdentities.has(key)) {
      if (JSON.stringify(this.tokenResponseIdentities.get(key)) !== JSON.stringify(captured))
        this.tokenResponseIdentities.set(key, null);
    } else if (this.tokenResponseIdentities.size >= 32) {
      this.tokenResponseCapacityReached = true;
      this.tokenResponseIdentities.clear();
    } else this.tokenResponseIdentities.set(key, captured);
  }

  identity(token: string, generation: number | undefined): VerifiedProviderIdentity | null {
    if (!this.tokenEndpoint || this.tokenResponseCapacityReached) return null;
    const captured = this.tokenResponseIdentities.get(
      createHash("sha256").update(token).digest("hex"),
    );
    return captured?.generation === generation ? (captured?.identity ?? null) : null;
  }
}
