import type { Session } from "electron";
import { shell } from "electron";
import type { DeepLink } from "../shared/deep-link.ts";
import type { LoginPhase } from "../shared/ipc.ts";
import { createPkcePair, createState, sameState } from "../shared/pkce.ts";
import {
  type DesktopSession,
  loginStartUrl,
  type ServiceDescriptor,
} from "../shared/server-contract.ts";
import { exchangeDesktopSession } from "./server-client.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  origin: string;
  descriptor: ServiceDescriptor;
  verifier: string;
  state: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface LoginHooks {
  sessionFor(origin: string): Session;
  deviceId(origin: string): string;
  deviceLabel(): string;
  callback(): string;
  appVersion(): string;
  onPhase(phase: LoginPhase): void;
  onSignedIn(origin: string, descriptor: ServiceDescriptor, session: DesktopSession): void;
  onError(scope: string, error: unknown): void;
}

export class LoginController {
  private pending: Pending | null = null;

  constructor(private readonly hooks: LoginHooks) {}

  async start(origin: string, descriptor: ServiceDescriptor): Promise<void> {
    if (!descriptor.desktop) return;
    this.clear();
    const pkce = createPkcePair();
    const state = createState();
    const timer = setTimeout(() => this.fail("expired"), LOGIN_TIMEOUT_MS);
    this.pending = { origin, descriptor, verifier: pkce.verifier, state, timer };
    const url = loginStartUrl(origin, descriptor.desktop.login, {
      challenge: pkce.challenge,
      state,
      deviceId: this.hooks.deviceId(origin),
      deviceLabel: this.hooks.deviceLabel(),
      callback: this.hooks.callback(),
      appVersion: this.hooks.appVersion(),
    });
    try {
      await shell.openExternal(url);
      this.hooks.onPhase({ phase: "waiting", origin });
    } catch (error) {
      this.hooks.onError("login.open-browser", error);
      this.fail("browser-failed");
    }
  }

  cancel(): void {
    if (this.pending) this.fail("cancelled");
  }

  async handle(link: Extract<DeepLink, { kind: "callback" | "callback-error" }>): Promise<boolean> {
    const pending = this.pending;
    if (!pending || !link.state || !sameState(pending.state, link.state)) {
      this.hooks.onError("login.callback", new Error("ignored a callback with an unknown state"));
      return false;
    }
    if (link.kind === "callback-error") {
      this.fail(
        link.error === "access_denied" || link.error === "cancelled" ? "cancelled" : "rejected",
      );
      return true;
    }
    this.clear();
    const { origin, descriptor } = pending;
    if (!descriptor.desktop) return false;
    this.hooks.onPhase({ phase: "exchanging", origin });
    const result = await exchangeDesktopSession(
      this.hooks.sessionFor(origin),
      origin,
      descriptor.desktop.login,
      {
        code: link.code,
        verifier: pending.verifier,
        state: pending.state,
        appVersion: this.hooks.appVersion(),
      },
    );
    if (!result.ok) {
      this.hooks.onPhase({ phase: "failed", origin, reason: result.reason });
      return true;
    }
    this.hooks.onPhase({ phase: "idle" });
    this.hooks.onSignedIn(origin, descriptor, result.session);
    return true;
  }

  private clear(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private fail(reason: Extract<LoginPhase, { phase: "failed" }>["reason"]): void {
    const origin = this.pending?.origin;
    this.clear();
    if (origin) this.hooks.onPhase({ phase: "failed", origin, reason });
  }
}
