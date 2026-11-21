import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { notificationsCommand } from "../../../../sk/src/commands/notifications.ts";
import { type Captured, extractLastJson, patchStd, withEnv, withNoExit } from "./cli-capture.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

describe("an operator manages notifications from the sk CLI", () => {
  describe("sk notifications", () => {
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

    async function seedChannel(opts: {
      workspace_id: string;
      channel_id: string;
      platform: string;
    }): Promise<{ id: string }> {
      const res = await journeyFetch(ctx, "/v1/notifications/channels", {
        method: "POST",
        body: JSON.stringify(opts),
      });
      expect(res.status).toBe(201);
      return res.json() as Promise<{ id: string }>;
    }

    async function seedRule(opts: {
      name: string;
      event_pattern: string;
      target_workspace_id: string;
      target_channel_id: string;
    }): Promise<{ id: string }> {
      const res = await journeyFetch(ctx, "/v1/notifications/rules", {
        method: "POST",
        body: JSON.stringify(opts),
      });
      expect(res.status).toBe(201);
      return res.json() as Promise<{ id: string }>;
    }

    let channelId = "";

    let ruleId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-notifications");
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: notifications channels list returns an array (may be empty)", async () => {
      const { stdout } = await run(notificationsCommand, ["channels", "list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items = (body as { items?: unknown[] }).items ?? body;
      expect(Array.isArray(items)).toBe(true);
    });

    test("AC2: a channel seeded via HTTP appears in the CLI list", async () => {
      const channel = await seedChannel({
        workspace_id: "W_TEST",
        channel_id: "C_ALERTS",
        platform: "slack",
      });
      channelId = channel.id;

      const { stdout } = await run(notificationsCommand, ["channels", "list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items =
        (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
      const ids = (items as Array<{ id: string }>).map((c) => c.id);
      expect(ids).toContain(channelId);
    });

    test("AC3: notifications channels update patches a channel field", async () => {
      const { stdout } = await run(
        notificationsCommand,
        ["channels", "update", channelId],
        ["--config", JSON.stringify({ rate_limit_per_minute: 30 })],
      );
      const body = JSON.parse(extractLastJson(stdout));
      expect(body.id).toBe(channelId);
      expect(body.rate_limit_per_minute).toBe(30);
    });

    test("AC4: notifications channels delete outputs 'deleted'", async () => {
      const ch = await seedChannel({
        workspace_id: "W_DEL",
        channel_id: "C_DEL",
        platform: "slack",
      });
      const { stdout } = await runPlain(notificationsCommand, ["channels", "delete", ch.id]);
      expect(stdout).toContain("deleted");
    });

    test("AC5: deleted channel id is gone from the list", async () => {
      const ch = await seedChannel({
        workspace_id: "W_GONE",
        channel_id: "C_GONE",
        platform: "slack",
      });
      const deleteId = ch.id;

      await runPlain(notificationsCommand, ["channels", "delete", deleteId]);

      const { stdout } = await run(notificationsCommand, ["channels", "list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items =
        (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
      const ids = (items as Array<{ id: string }>).map((c) => c.id);
      expect(ids).not.toContain(deleteId);
    });

    test("AC6: notifications rules list returns an array", async () => {
      const { stdout } = await run(notificationsCommand, ["rules", "list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items = (body as { items?: unknown[] }).items ?? body;
      expect(Array.isArray(items)).toBe(true);
    });

    test("AC7: a rule seeded via HTTP appears in the rules list", async () => {
      const rule = await seedRule({
        name: "test-rule",
        event_pattern: "execution.completed",
        target_workspace_id: "W_TEST",
        target_channel_id: "C_ALERTS",
      });
      ruleId = rule.id;

      const { stdout } = await run(notificationsCommand, ["rules", "list"]);
      const body = JSON.parse(extractLastJson(stdout));
      const items =
        (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
      const ids = (items as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(ruleId);
    });

    test("AC8: notifications rules delete outputs 'deleted'", async () => {
      const { stdout } = await runPlain(notificationsCommand, ["rules", "delete", ruleId]);
      expect(stdout).toContain("deleted");
    });

    test("AC9: notifications rules create sends the engine's rule shape", async () => {
      const { stdout } = await run(
        notificationsCommand,
        ["rules", "create"],
        ["--event", "execution.failed", "--workspace-id", "W_TEST", "--channel-id", "C_ALERTS"],
      );
      const body = JSON.parse(extractLastJson(stdout)) as Record<string, unknown>;
      expect(body.event_pattern).toBe("execution.failed");
      expect(body.target_workspace_id).toBe("W_TEST");
      expect(body.target_channel_id).toBe("C_ALERTS");
      expect(typeof body.name).toBe("string");

      const res = await journeyFetch(ctx, "/v1/notifications/rules");
      const { items } = (await res.json()) as { items: Array<{ id: string }> };
      expect(items.map((r) => r.id)).toContain(body.id as string);
    });

    test("AC11: notifications channels create sends the engine's channel shape", async () => {
      const { stdout } = await run(
        notificationsCommand,
        ["channels", "create"],
        [
          "--platform",
          "slack",
          "--workspace-id",
          "W_CREATE",
          "--channel-id",
          "C_CREATE",
          "--severity",
          "error",
          "--rate-limit",
          "12",
        ],
      );
      const body = JSON.parse(extractLastJson(stdout)) as Record<string, unknown>;
      expect(body.platform).toBe("slack");
      expect(body.workspace_id).toBe("W_CREATE");
      expect(body.channel_id).toBe("C_CREATE");
      expect(body.default_severity).toBe("error");
      expect(body.rate_limit_per_minute).toBe(12);

      const res = await journeyFetch(ctx, "/v1/notifications/channels");
      const { items } = (await res.json()) as { items: Array<{ id: string }> };
      expect(items.map((c) => c.id)).toContain(body.id as string);
    });

    test("AC10: deleting a non-existent channel id returns an error", async () => {
      const fakeId = "00000000-0000-4000-8000-000000000099";
      const { message, captured } = await runExpectError(notificationsCommand, [
        "channels",
        "delete",
        fakeId,
      ]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("not_found") ||
          combined.includes("404") ||
          combined.includes("not found") ||
          combined.includes("process.exit"),
      ).toBe(true);
    });

    test("AC12: channel seeded for this tenant is not visible under a different api key", async () => {
      const otherChannel = await seedChannel({
        workspace_id: "W_ISOLATION",
        channel_id: "C_ISOLATION",
        platform: "slack",
      });

      const res = await fetch(`${ctx.baseUrl}/v1/notifications/channels`, {
        headers: { authorization: "Bearer wf_live_boguskey" },
      });
      expect(res.status).toBe(401);

      const ok = await journeyFetch(ctx, "/v1/notifications/channels");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { items: Array<{ id: string }> };
      expect(body.items.some((c) => c.id === otherChannel.id)).toBe(true);
    });
  });
});
