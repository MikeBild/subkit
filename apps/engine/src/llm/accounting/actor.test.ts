import { describe, expect, it } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { actorFields } from "./actor.ts";

const BASE: Omit<ResolvedPrincipal, "kind" | "id"> = {
  provider: "test",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  roles: [],
};

describe("actorFields", () => {
  it("user principal → user_id set to id and actor_type=user", () => {
    const principal: ResolvedPrincipal = {
      ...BASE,
      kind: "user",
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    };
    const result = actorFields(principal);
    expect(result.user_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(result.actor_type).toBe("user");
  });

  it("system_account principal → user_id set to id and actor_type=system_account", () => {
    const principal: ResolvedPrincipal = {
      ...BASE,
      kind: "system_account",
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    };
    const result = actorFields(principal);
    expect(result.user_id).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(result.actor_type).toBe("system_account");
  });

  it("null principal → user_id=null and actor_type=system", () => {
    const result = actorFields(null);
    expect(result.user_id).toBeNull();
    expect(result.actor_type).toBe("system");
  });

  it("undefined principal → user_id=null and actor_type=system", () => {
    const result = actorFields(undefined);
    expect(result.user_id).toBeNull();
    expect(result.actor_type).toBe("system");
  });

  it("no argument → user_id=null and actor_type=system", () => {
    const result = actorFields();
    expect(result.user_id).toBeNull();
    expect(result.actor_type).toBe("system");
  });
});
