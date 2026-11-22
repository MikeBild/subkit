import { describe, expect, test } from "bun:test";
import { joinCommand, runJoin } from "../join.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const cmd = joinCommand as unknown as {
  meta: { name: string; description: string };
  args: Record<string, { type: string; required?: boolean }>;
};

describe("subkit join — citty surface", () => {
  test("meta.name is 'join' and --invite is required", () => {
    expect(cmd.meta.name).toBe("join");
    expect(cmd.args.invite).toBeDefined();
    expect(cmd.args.invite?.required).toBe(true);
    expect(cmd.args["engine-url"]).toBeDefined();
    expect(cmd.args.profile).toBeDefined();
  });
});

describe("runJoin — happy path", () => {
  test("redeems UNAUTHENTICATED, saves the profile, prints the next step", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    let saved: { name: string; api_key: string; active_tenant_id: string | null } | null = null;
    const out: string[] = [];

    const result = await runJoin({
      token: "wf_invite_abcd1234secret",
      engine_url: "http://engine.test",
      profile: "default",
      out: (l) => out.push(l),
      err: () => undefined,
      fetchImpl: ((url: string, init?: RequestInit) => {
        captured = { url, init: init ?? {} };
        return Promise.resolve(
          jsonResponse({
            user_id: "11111111-1111-1111-1111-111111111111",
            tenant_id: "22222222-2222-2222-2222-222222222222",
            api_key: "wf_live_personal_plaintext",
            api_key_prefix: "wf_live_personal",
          }),
        );
      }) as unknown as typeof fetch,
      saveProfileImpl: ((p) => {
        saved = {
          name: p.name,
          api_key: p.api_key,
          active_tenant_id: p.active_tenant_id,
        };
      }) as typeof import("../../config.ts").saveProfile,
    });

    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(captured!.url).toBe("http://engine.test/v1/identity/invites/redeem");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const sent = JSON.parse(String(captured!.init.body)) as Record<string, unknown>;
    expect(sent.token).toBe("wf_invite_abcd1234secret");

    expect(saved).not.toBeNull();
    expect(saved!.api_key).toBe("wf_live_personal_plaintext");
    expect(saved!.active_tenant_id).toBe("22222222-2222-2222-2222-222222222222");

    const printed = out.join("");
    expect(printed).toContain("joined");
    expect(printed).toContain("subkit status");
  });
});

describe("runJoin — typed redeem errors", () => {
  test("maps invite_expired to a friendly message and fails", async () => {
    const errs: string[] = [];
    let saveCalls = 0;
    const result = await runJoin({
      token: "wf_invite_stale",
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (l) => errs.push(l),
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse(
            { code: "invite_expired", message: "invite redemption failed: invite_expired" },
            400,
          ),
        )) as unknown as typeof fetch,
      saveProfileImpl: (() => {
        saveCalls += 1;
      }) as typeof import("../../config.ts").saveProfile,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invite_expired");
    expect(result.exitCode).toBe(1);
    expect(saveCalls).toBe(0);
    const all = errs.join("");
    expect(all).toContain("expired");
    expect(all).toContain("code=invite_expired");
  });

  test("unknown code falls back to the engine message", async () => {
    const errs: string[] = [];
    const result = await runJoin({
      token: "wf_invite_x",
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (l) => errs.push(l),
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse({ code: "some_new_code", message: "a brand new failure" }, 400),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("some_new_code");
    expect(errs.join("")).toContain("a brand new failure");
  });
});
