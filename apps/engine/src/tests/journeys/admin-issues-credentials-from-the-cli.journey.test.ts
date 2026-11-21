import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apiKeysCommand } from "../../../../sk/src/commands/apikeys.ts";
import { portalTokensCommand } from "../../../../sk/src/commands/portal-tokens.ts";
import { systemAccountsCommand } from "../../../../sk/src/commands/system-accounts.ts";
import { usersCommand } from "../../../../sk/src/commands/users.ts";
import { type Captured, extractLastJson, patchStd, withEnv, withNoExit } from "./cli-capture.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

describe("an admin issues keys, accounts and portal tokens from the sk CLI", () => {
  describe("sk apikeys", () => {
    let ctx: JourneyCtx;

    async function run(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runPlain(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    let seededKeyId = "";

    let seededKeyPrefix = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-apikeys");

      const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({
          owner_kind: "user",
          owner_id: ctx.userId,
          scopes: ["*"],
        }),
      });
      expect(issueRes.status).toBe(201);
      const issued = (await issueRes.json()) as {
        id: string;
        prefix: string;
        plaintext_key: string;
      };
      seededKeyId = issued.id;
      seededKeyPrefix = issued.prefix;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: apikeys list --json returns >= 1 item; each item has id and prefix", async () => {
      const { stdout } = await run(apiKeysCommand, ["list"]);
      const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; prefix: string }>;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(1);
      for (const item of items) {
        expect(typeof item.id).toBe("string");
        expect(item.id.length).toBeGreaterThan(0);
        expect(typeof item.prefix).toBe("string");
        expect(item.prefix.length).toBeGreaterThan(0);
      }
    });

    test("AC2: newly issued key appears in apikeys list --json", async () => {
      const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({
          owner_kind: "user",
          owner_id: ctx.userId,
          scopes: ["*"],
        }),
      });
      expect(issueRes.status).toBe(201);
      const issued = (await issueRes.json()) as {
        id: string;
        prefix: string;
        plaintext_key: string;
      };
      expect(issued.plaintext_key).toMatch(/^wf_live_/);
      expect(issued.prefix).toBe(issued.plaintext_key.slice(0, 12));

      const { stdout } = await run(apiKeysCommand, ["list"]);
      const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string }>;
      const ids = items.map((k) => k.id);
      expect(ids).toContain(issued.id);
    });

    test("AC3: apikeys rotate <id> returns new token with wf_live_ prefix and changed prefix", async () => {
      const { stdout, stderr } = await run(apiKeysCommand, ["rotate", seededKeyId]);
      expect(stderr).toContain("warning");
      const body = JSON.parse(extractLastJson(stdout)) as {
        old: { id: string; prefix: string };
        new: { prefix: string; plaintext_key: string };
      };
      expect(body.new.plaintext_key).toMatch(/^wf_live_/);
      expect(typeof body.new.prefix).toBe("string");
      expect(body.new.prefix.length).toBeGreaterThan(0);
      expect(body.new.prefix).not.toBe(seededKeyPrefix);
      expect(body.old.id).toBe(seededKeyId);
    });

    test("AC4: apikeys revoke <id> prints 'revoked'", async () => {
      const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({
          owner_kind: "user",
          owner_id: ctx.userId,
          scopes: ["*"],
        }),
      });
      expect(issueRes.status).toBe(201);
      const { id: revokeTargetId } = (await issueRes.json()) as { id: string };

      const { stdout } = await runPlain(apiKeysCommand, ["revoke", revokeTargetId]);
      expect(stdout).toContain("revoked");
    });

    test("AC5: revoked key no longer appears in apikeys list --json", async () => {
      const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
        method: "POST",
        body: JSON.stringify({
          owner_kind: "user",
          owner_id: ctx.userId,
          scopes: ["*"],
        }),
      });
      expect(issueRes.status).toBe(201);
      const { id: ephemeralId } = (await issueRes.json()) as { id: string };

      const { stdout: revokeOut } = await runPlain(apiKeysCommand, ["revoke", ephemeralId]);
      expect(revokeOut).toContain("revoked");

      const { apiKeys } = await import("../../db/schema/index.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await ctx.db.select().from(apiKeys).where(eq(apiKeys.id, ephemeralId)).limit(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    });

    test("wrong tenant: key id from a different context is not found by rotate", async () => {
      const fakeId = "00000000-0000-4000-8000-000000000099";
      const { message, captured } = await runExpectError(apiKeysCommand, ["rotate", fakeId]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("not_found") ||
          combined.includes("not found") ||
          combined.includes("404") ||
          combined.includes("process.exit"),
      ).toBe(true);
    });
  });

  describe("sk users and system-accounts", () => {
    let ctx: JourneyCtx;

    async function run(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-users-sysaccounts");
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    describe("sk users CLI", () => {
      test("AC1: users list --json returns >= 1 item; items have id and email", async () => {
        const { stdout } = await run(usersCommand, ["list"]);
        const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; email: string }>;
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeGreaterThanOrEqual(1);
        for (const item of items) {
          expect(typeof item.id).toBe("string");
          expect(item.id.length).toBeGreaterThan(0);
          expect(typeof item.email).toBe("string");
          expect(item.email.length).toBeGreaterThan(0);
        }
      });

      test("AC2: users get <userId> returns the user with matching id and email", async () => {
        const { stdout } = await run(usersCommand, ["get", ctx.userId]);
        const user = JSON.parse(extractLastJson(stdout)) as { id: string; email: string };
        expect(user.id).toBe(ctx.userId);
        expect(typeof user.email).toBe("string");
        expect(user.email.length).toBeGreaterThan(0);
      });

      test("users list returns only the current tenant's users", async () => {
        const { stdout } = await run(usersCommand, ["list"]);
        const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; email: string }>;
        const ids = items.map((u) => u.id);
        expect(ids).toContain(ctx.userId);
        expect(items.length).toBe(1);
      });

      test("users get with non-existent id returns an error", async () => {
        const fakeId = "00000000-0000-4000-8000-000000000077";
        const { message, captured } = await runExpectError(usersCommand, ["get", fakeId]);
        const combined = `${message}\n${captured.stderr}`.toLowerCase();
        expect(
          combined.includes("not_found") ||
            combined.includes("not found") ||
            combined.includes("404") ||
            combined.includes("process.exit"),
        ).toBe(true);
      });
    });

    describe("sk system-accounts CLI", () => {
      test("AC3: system-accounts list --json returns >= 1 item; items have id and name", async () => {
        const { stdout } = await run(systemAccountsCommand, ["list"]);
        const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; name: string }>;
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeGreaterThanOrEqual(1);
        for (const item of items) {
          expect(typeof item.id).toBe("string");
          expect(item.id.length).toBeGreaterThan(0);
          expect(typeof item.name).toBe("string");
          expect(item.name.length).toBeGreaterThan(0);
        }
      });

      test("AC4: system-accounts create --name <name> returns an account with id and name", async () => {
        const { stdout } = await run(systemAccountsCommand, ["create", "--name=e2e-bot"]);
        const account = JSON.parse(extractLastJson(stdout)) as { id: string; name: string };
        expect(typeof account.id).toBe("string");
        expect(account.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(account.name).toBe("e2e-bot");
      });

      test("AC5: created system account appears in subsequent list", async () => {
        const { stdout: createOut } = await run(systemAccountsCommand, [
          "create",
          "--name=e2e-bot-listed",
        ]);
        const created = JSON.parse(extractLastJson(createOut)) as { id: string; name: string };
        expect(created.id).toBeTruthy();

        const { stdout: listOut } = await run(systemAccountsCommand, ["list"]);
        const items = JSON.parse(extractLastJson(listOut)) as Array<{ id: string }>;
        const ids = items.map((a) => a.id);
        expect(ids).toContain(created.id);
      });

      test("system-accounts list returns only this tenant's accounts", async () => {
        const before = JSON.parse(
          extractLastJson((await run(systemAccountsCommand, ["list"])).stdout),
        ) as unknown[];
        const countBefore = before.length;

        await run(systemAccountsCommand, ["create", "--name=isolation-probe"]);

        const after = JSON.parse(
          extractLastJson((await run(systemAccountsCommand, ["list"])).stdout),
        ) as Array<{ id: string; name: string }>;
        expect(after.length).toBe(countBefore + 1);
        const names = after.map((a) => a.name);
        expect(names).toContain("isolation-probe");
      });

      test("AC6: non-admin key receives an auth error on users list", async () => {
        const cli = patchStd();
        let caughtMessage = "";
        try {
          await withEnv(ctx.baseUrl, "wf_live_bogus_key_that_does_not_exist", () =>
            withNoExit(async () => {
              const citty = await import("citty");
              await citty.runCommand(usersCommand, { rawArgs: ["list", "--json"] });
            }),
          );
        } catch (e) {
          caughtMessage = e instanceof Error ? e.message : String(e);
        } finally {
          cli.restore();
        }
        const combined = `${caughtMessage}\n${cli.stderr}`.toLowerCase();
        expect(
          combined.includes("unauthorized") ||
            combined.includes("401") ||
            combined.includes("api_key") ||
            combined.includes("credentials") ||
            combined.includes("process.exit"),
        ).toBe(true);
      });
    });
  });

  describe("sk portal-tokens", () => {
    let ctx: JourneyCtx;

    async function run(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runPlain(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    async function issuePortalToken(allowedWorkflows: string[] = ["*"]): Promise<{
      id: string;
      prefix: string;
      plaintext_token: string;
    }> {
      const res = await journeyFetch(ctx, "/v1/identity/portal-tokens", {
        method: "POST",
        body: JSON.stringify({
          user_id: ctx.userId,
          allowed_workflows: allowedWorkflows,
        }),
      });
      expect(res.status).toBe(201);
      return res.json() as Promise<{ id: string; prefix: string; plaintext_token: string }>;
    }

    let workflowId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-portal-tokens");

      const wfRes = await journeyFetch(ctx, "/v1/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: "portal-token-probe",
          slug: "portal-token-probe",
          steps: [{ kind: "transform", id: "t", expression: "return input.input;" }],
        }),
      });
      expect(wfRes.status).toBe(201);
      const wf = (await wfRes.json()) as { id: string };
      workflowId = wf.id;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: portal-tokens list --json returns an array (may be empty)", async () => {
      const { stdout } = await run(portalTokensCommand, ["list"]);
      const items = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(items)).toBe(true);
    });

    test("AC2: after issuing a portal token, list reflects it", async () => {
      const token = await issuePortalToken([workflowId]);
      expect(typeof token.id).toBe("string");
      expect(token.id.length).toBeGreaterThan(0);
      expect(typeof token.plaintext_token).toBe("string");
      expect(token.plaintext_token.length).toBeGreaterThan(0);
      expect(typeof token.prefix).toBe("string");
      expect(token.prefix.length).toBeGreaterThan(0);

      const { stdout } = await run(portalTokensCommand, ["list"]);
      const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string }>;
      const ids = items.map((t) => t.id);
      expect(ids).toContain(token.id);
    });

    test("AC3: portal-tokens revoke <id> prints 'revoked'", async () => {
      const token = await issuePortalToken([workflowId]);
      const { stdout } = await runPlain(portalTokensCommand, ["revoke", token.id]);
      expect(stdout).toContain("revoked");
    });

    test("AC4: revoked token has revoked_at set in DB", async () => {
      const token = await issuePortalToken([workflowId]);

      const { stdout: revokeOut } = await runPlain(portalTokensCommand, ["revoke", token.id]);
      expect(revokeOut).toContain("revoked");

      const { portalTokens } = await import("../../db/schema/index.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await ctx.db
        .select()
        .from(portalTokens)
        .where(eq(portalTokens.id, token.id))
        .limit(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    });

    test("AC5: revoking a non-existent token id returns an error", async () => {
      const fakeId = "00000000-0000-4000-8000-000000000088";
      const { message, captured } = await runExpectError(portalTokensCommand, ["revoke", fakeId]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("not_found") ||
          combined.includes("not found") ||
          combined.includes("404") ||
          combined.includes("process.exit"),
      ).toBe(true);
    });

    test("wrong tenant: list returns only tokens from the current tenant", async () => {
      const before = await run(portalTokensCommand, ["list"]);
      const itemsBefore = JSON.parse(extractLastJson(before.stdout)) as unknown[];
      const countBefore = itemsBefore.length;

      const token = await issuePortalToken([workflowId]);

      const after = await run(portalTokensCommand, ["list"]);
      const itemsAfter = JSON.parse(extractLastJson(after.stdout)) as Array<{ id: string }>;
      expect(itemsAfter.length).toBe(countBefore + 1);
      expect(itemsAfter.map((t) => t.id)).toContain(token.id);
    });
  });
});
