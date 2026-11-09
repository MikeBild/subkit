import { expect, test } from "bun:test";
import type { Executor } from "../db/client.ts";
import { users } from "../db/schema/index.ts";
import { assertAdminRemains, LastAdminError } from "./last-admin.ts";

function lockedUsers(rows: readonly { id: string; assigned: string | null }[]) {
  let lock: { mode: string; of: unknown } | null = null;
  const tx = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            for: (mode: string, options: { of: unknown }) => {
              lock = { mode, of: options.of };
              return Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
  } as unknown as Executor;
  return { tx, lock: () => lock };
}

test("last-admin shell locks the active tenant snapshot before rejecting a demotion", async () => {
  const fixture = lockedUsers([{ id: "admin", assigned: "admin" }]);
  await expect(
    assertAdminRemains(fixture.tx, {
      tenant_id: "tenant-a",
      user_id: "admin",
      nextEffectiveRole: "member",
    }),
  ).rejects.toBeInstanceOf(LastAdminError);
  expect(fixture.lock()).toEqual({ mode: "update", of: users });
});

test("last-admin shell does not query or lock when administrator access is retained", async () => {
  const tx = {
    select: () => {
      throw new Error("retaining administrator access must not read active users");
    },
  } as unknown as Executor;
  await expect(
    assertAdminRemains(tx, {
      tenant_id: "tenant-a",
      user_id: "admin",
      nextEffectiveRole: "admin",
    }),
  ).resolves.toBeUndefined();
});

test("last-admin shell allows a demotion when the locked snapshot has another active administrator", async () => {
  const fixture = lockedUsers([
    { id: "admin", assigned: "admin" },
    { id: "other-admin", assigned: "admin" },
  ]);
  await expect(
    assertAdminRemains(fixture.tx, {
      tenant_id: "tenant-a",
      user_id: "admin",
      nextEffectiveRole: "member",
    }),
  ).resolves.toBeUndefined();
  expect(fixture.lock()).toEqual({ mode: "update", of: users });
});
