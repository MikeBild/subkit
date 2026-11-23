import { describe, expect, test } from "bun:test";
import {
  type AuthorityCandidate,
  authorityRefusal,
  decideAuthorityAvailability,
  lastUnavailable,
  selectAuthority,
} from "./authority-availability.ts";

const NOW = new Date("2026-11-23T10:00:00Z");
const before = (ms: number) => new Date(NOW.getTime() - ms);
const after = (ms: number) => new Date(NOW.getTime() + ms);

function row(over: Partial<AuthorityCandidate> = {}): AuthorityCandidate {
  return {
    revoked_at: null,
    valid_from: before(1000),
    valid_until: after(1000),
    max_runs: 3,
    reserved_runs: 1,
    workflow_version_id: "v2",
    effect_manifest_digest: "d2",
    superseded: false,
    ...over,
  };
}

const reserve = {
  now: NOW,
  use: "reserve",
  current_version_id: "v2",
  boundary_digest: "d2",
} as const;

describe("one verdict says whether an approval can carry a run", () => {
  test("an approval inside its window with runs left is live", () => {
    expect(decideAuthorityAvailability({ ...reserve, authority: row() })).toBe("live");
    expect(
      decideAuthorityAvailability({
        ...reserve,
        authority: row({ valid_until: null, max_runs: null, reserved_runs: 900 }),
      }),
    ).toBe("live");
  });

  test("no approval at all is none", () => {
    expect(decideAuthorityAvailability({ ...reserve, authority: null })).toBe("none");
  });

  test("a revoked approval is revoked before anything else", () => {
    expect(
      decideAuthorityAvailability({
        ...reserve,
        authority: row({
          revoked_at: before(5),
          valid_until: before(1),
          reserved_runs: 3,
          workflow_version_id: "v1",
        }),
      }),
    ).toBe("revoked");
  });

  test("an approval for another version is version_changed", () => {
    expect(
      decideAuthorityAvailability({ ...reserve, authority: row({ workflow_version_id: "v1" }) }),
    ).toBe("version_changed");
  });

  test("the version is not compared when no current version is given", () => {
    expect(
      decideAuthorityAvailability({
        now: NOW,
        use: "reserve",
        authority: row({ workflow_version_id: "v1" }),
      }),
    ).toBe("live");
  });

  test("the window end is exclusive", () => {
    expect(decideAuthorityAvailability({ ...reserve, authority: row({ valid_until: NOW }) })).toBe(
      "expired",
    );
    expect(
      decideAuthorityAvailability({ ...reserve, authority: row({ valid_until: after(1) }) }),
    ).toBe("live");
  });

  test("an approval that starts later is not there yet", () => {
    expect(
      decideAuthorityAvailability({ ...reserve, authority: row({ valid_from: after(1) }) }),
    ).toBe("none");
    expect(decideAuthorityAvailability({ ...reserve, authority: row({ valid_from: NOW }) })).toBe(
      "live",
    );
  });

  test("a new run needs a run left", () => {
    expect(decideAuthorityAvailability({ ...reserve, authority: row({ reserved_runs: 3 }) })).toBe(
      "exhausted",
    );
    expect(decideAuthorityAvailability({ ...reserve, authority: row({ reserved_runs: 2 }) })).toBe(
      "live",
    );
  });

  test("a run that already holds its reservation is not stopped by a full count", () => {
    expect(
      decideAuthorityAvailability({
        ...reserve,
        use: "reserved",
        authority: row({ reserved_runs: 3 }),
      }),
    ).toBe("live");
    expect(
      decideAuthorityAvailability({
        ...reserve,
        use: "reserved",
        authority: row({ reserved_runs: 0 }),
      }),
    ).toBe("none");
  });

  test("a different effect boundary is boundary_changed, after expiry and exhaustion", () => {
    expect(
      decideAuthorityAvailability({
        ...reserve,
        authority: row({ effect_manifest_digest: "d1" }),
      }),
    ).toBe("boundary_changed");
    expect(
      decideAuthorityAvailability({
        ...reserve,
        authority: row({ effect_manifest_digest: "d1", valid_until: before(1) }),
      }),
    ).toBe("expired");
    expect(
      decideAuthorityAvailability({
        ...reserve,
        authority: row({ effect_manifest_digest: "d1", reserved_runs: 3 }),
      }),
    ).toBe("exhausted");
    expect(
      decideAuthorityAvailability({
        now: NOW,
        use: "reserve",
        authority: row({ effect_manifest_digest: "d1" }),
      }),
    ).toBe("live");
  });
});

describe("each verdict maps to one refusal code", () => {
  test("the mapping", () => {
    expect(authorityRefusal("expired").code).toBe("execution_authority_expired");
    expect(authorityRefusal("exhausted").code).toBe("execution_authority_exhausted");
    expect(authorityRefusal("revoked").code).toBe("execution_authority_revoked");
    expect(authorityRefusal("boundary_changed").code).toBe("execution_authority_changed");
    expect(authorityRefusal("version_changed").code).toBe("execution_authority_required");
    expect(authorityRefusal("none").code).toBe("execution_authority_required");
  });
});

describe("admission picks the approval that explains the outcome", () => {
  test("a live approval wins over a newer dead one", () => {
    const dead = row({ revoked_at: before(1) });
    const live = row();
    expect(selectAuthority([dead, live], reserve)).toEqual({
      authority: live,
      availability: "live",
    });
  });

  test("without a live approval the newest of the active version explains", () => {
    const old = row({ workflow_version_id: "v1" });
    const expired = row({ valid_until: before(1) });
    expect(selectAuthority([old, expired], reserve)).toEqual({
      authority: expired,
      availability: "expired",
    });
  });

  test("drift of the effect boundary is reported as changed", () => {
    expect(selectAuthority([row({ effect_manifest_digest: "d1" })], reserve).availability).toBe(
      "boundary_changed",
    );
  });

  test("a replaced approval does not explain while a standing one exists", () => {
    const replaced = row({ revoked_at: before(1), superseded: true });
    const used = row({ reserved_runs: 3 });
    expect(selectAuthority([replaced, used], reserve).availability).toBe("exhausted");
    expect(selectAuthority([replaced], reserve).availability).toBe("revoked");
  });

  test("only approvals of older versions yield version_changed, none yields none", () => {
    expect(selectAuthority([row({ workflow_version_id: "v1" })], reserve).availability).toBe(
      "version_changed",
    );
    expect(selectAuthority([], reserve)).toEqual({ authority: null, availability: "none" });
  });
});

describe("a run that lost its approval names the latest reason", () => {
  test("the last approval looked at explains, a live one never does", () => {
    expect(lastUnavailable(["revoked", "expired"])).toBe("expired");
    expect(lastUnavailable(["revoked", "live"])).toBe("revoked");
    expect(lastUnavailable([])).toBe("none");
  });
});
