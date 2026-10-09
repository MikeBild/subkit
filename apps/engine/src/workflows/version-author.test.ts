import { expect, test } from "bun:test";
import { readVersionAuthor, versionAuthorColumns } from "./version-author.ts";

test("version authors require an explicit principal kind", () => {
  for (const actor of [
    {},
    { actor_id: "actor" },
    { actor_id: "actor", actor_type: "system" as const },
  ]) {
    expect(readVersionAuthor(versionAuthorColumns(actor))).toBeNull();
  }
  for (const actor_type of ["user", "system_account"] as const) {
    expect(readVersionAuthor(versionAuthorColumns({ actor_id: "actor", actor_type }))).toEqual({
      kind: actor_type,
      id: "actor",
    });
    expect(readVersionAuthor(versionAuthorColumns({ actor_id: null, actor_type }))).toBeNull();
  }
});

test("conflicting historical author columns never invent an identity", () => {
  expect(
    readVersionAuthor({ author_user_id: "user", author_system_account_id: "account" }),
  ).toBeNull();
});
