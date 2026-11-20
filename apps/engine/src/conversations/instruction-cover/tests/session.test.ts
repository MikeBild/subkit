import { describe, expect, test } from "bun:test";
import type { ExecutionAuthSource } from "../../../auth/types.ts";
import { interactivePersonRefusal } from "../session.ts";

const browser: ExecutionAuthSource = { kind: "browser_session", session_id: "s" };

describe("only a person in a signed-in browser session counts as the person", () => {
  test("a Cockpit session on an interactive surface counts", () => {
    for (const surface of ["web", "chat"]) {
      expect(
        interactivePersonRefusal({
          principal: { kind: "user", auth_source: browser },
          surface,
          task_run: false,
        }),
      ).toBeNull();
    }
  });

  test("an API key, an MCP token, an exchanged or external token never count", () => {
    const sources: ExecutionAuthSource[] = [
      { kind: "api_key", api_key_id: "k", credential_version: "1" },
      { kind: "mcp_oauth", access_token_id: "t", client_id: "c" },
      { kind: "token_exchange", api_key_id: "k", credential_version: "1", expires_at: "x" },
      {
        kind: "external_bearer",
        provider_id: "p",
        identity_id: "i",
        issued_at: "a",
        expires_at: "b",
      },
    ];
    for (const auth_source of sources) {
      expect(
        interactivePersonRefusal({
          principal: { kind: "user", auth_source },
          surface: "web",
          task_run: false,
        }),
      ).toBe("no_browser_session");
    }
    expect(
      interactivePersonRefusal({ principal: { kind: "user" }, surface: "web", task_run: false }),
    ).toBe("no_browser_session");
  });

  test("a browser session that carries a key, a CLI origin or an exchange does not count", () => {
    const base = { kind: "user" as const, auth_source: browser };
    for (const extra of [
      { api_key_id: "k" },
      { credential_origin: "cli_oauth_session" as const },
      { via: "token_exchange" as const },
    ]) {
      expect(
        interactivePersonRefusal({
          principal: { ...base, ...extra },
          surface: "web",
          task_run: false,
        }),
      ).toBe("no_browser_session");
    }
  });

  test("the MCP and CLI surfaces, a missing surface and a system account never count", () => {
    for (const surface of ["mcp", "sk_headless", "sk_interactive", null, undefined, ""]) {
      expect(
        interactivePersonRefusal({
          principal: { kind: "user", auth_source: browser },
          surface,
          task_run: false,
        }),
      ).toBe("not_interactive_surface");
    }
    expect(
      interactivePersonRefusal({
        principal: { kind: "system_account", auth_source: browser },
        surface: "web",
        task_run: false,
      }),
    ).toBe("no_person");
    expect(interactivePersonRefusal({ principal: null, surface: "web", task_run: false })).toBe(
      "no_person",
    );
  });

  test("a task run or a scheduled context never counts", () => {
    expect(
      interactivePersonRefusal({
        principal: { kind: "user", auth_source: browser },
        surface: "web",
        task_run: true,
      }),
    ).toBe("task_run");
    expect(
      interactivePersonRefusal({
        principal: {
          kind: "user",
          auth_source: { kind: "task_run", task_id: "t", task_run_id: "r", grant_id: null },
        },
        surface: "web",
        task_run: false,
      }),
    ).toBe("task_run");
  });
});
