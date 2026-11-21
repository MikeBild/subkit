import { describe, expect, test } from "bun:test";
import { users } from "../../db/schema/index.ts";
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { dispatchTool } from "../dispatcher.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";
import type { ToolDescriptor } from "../types.ts";
import { dbPrincipal, testDb, useDispatcherDb } from "./dispatcher-fixtures.ts";

useDispatcherDb();

const preparation: ToolDescriptor = {
  name: "create_knowledge_source",
  description: "preparation write",
  category: "tenant_write",
  inputSchema: { type: "object" },
};

function registryCounting(runs: { count: number }) {
  const provider: ToolProvider = {
    name: "PreparationProvider",
    list: () => [preparation],
    resolve: (name) =>
      name === preparation.name
        ? {
            descriptor: preparation,
            executor: {
              kind: "conversation",
              tool: undefined as never,
              execute: async () => {
                runs.count += 1;
                return { ok: true, data: {} };
              },
            },
          }
        : undefined,
  };
  return buildRegistry([provider]);
}

async function person(email: string) {
  const tenant_id = dbPrincipal().tenant_id;
  const [row] = await testDb.db
    .insert(users)
    .values({ tenant_id, email, role_id: await builtinRoleId(testDb.db, "admin") })
    .returning({ id: users.id });
  if (!row) throw new Error("test user was not created");
  return dbPrincipal({ id: row.id, kind: "user" });
}

describe("tools/dispatcher — the person's ask-before-writing rule", () => {
  test("a preparation write runs without a question when the person has no rule", async () => {
    const principal = await person("no-rule@test.local");
    const runs = { count: 0 };
    const envelope = await dispatchTool(
      { registry: registryCounting(runs), db: testDb.db, principal, mcpMode: "admin" },
      { surface: "mcp", name: preparation.name, args: {} },
    );
    expect(envelope.status).not.toBe("needs_confirm");
  });

  test("the same write asks first once the person chose to ask before writing", async () => {
    const principal = await person("asks@test.local");
    await writeSetupPreferences(
      testDb.db,
      { tenant_id: principal.tenant_id, user_id: principal.id },
      { ask_before_writing: true },
    );
    const runs = { count: 0 };
    const envelope = await dispatchTool(
      { registry: registryCounting(runs), db: testDb.db, principal, mcpMode: "admin" },
      { surface: "mcp", name: preparation.name, args: {} },
    );
    expect(envelope.status).toBe("needs_confirm");
    if (envelope.status === "needs_confirm")
      expect(envelope.confirm.reason).toBe("ask_before_writing");
    expect(runs.count).toBe(0);
  });

  test("a system account keeps the default because no person stands behind it", async () => {
    const owner = await person("key-owner@test.local");
    await writeSetupPreferences(
      testDb.db,
      { tenant_id: owner.tenant_id, user_id: owner.id },
      { ask_before_writing: true },
    );
    const runs = { count: 0 };
    const envelope = await dispatchTool(
      {
        registry: registryCounting(runs),
        db: testDb.db,
        principal: { ...owner, kind: "system_account" },
        mcpMode: "admin",
      },
      { surface: "mcp", name: preparation.name, args: {} },
    );
    expect(envelope.status).not.toBe("needs_confirm");
  });
});
