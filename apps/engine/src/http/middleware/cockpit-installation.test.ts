import { describe, expect, test } from "bun:test";
import { cockpitInstallationRefusal } from "./cockpit-installation.ts";

const owner = { tenant_id: "tenant-1", user_id: "user-1" };
const installation = { tenant_id: "tenant-1", owner_user_id: "user-1", revoked_at: null };
const revoked = { ...installation, revoked_at: new Date("2026-11-20T10:00:00Z") };

describe("cockpitInstallationRefusal", () => {
  test("asks for a session when the installation is active, unknown or no cookie was verified", () => {
    for (const refusal of [
      cockpitInstallationRefusal(installation, owner),
      cockpitInstallationRefusal(null, owner),
      cockpitInstallationRefusal(revoked, null),
      cockpitInstallationRefusal(null, null),
    ])
      expect(refusal).toMatchObject({ status: 401, code: "installation_session_required" });
  });

  test("names the revocation only to the verified cookie of the installation's owner", () => {
    expect(cockpitInstallationRefusal(revoked, owner)).toMatchObject({
      status: 403,
      code: "installation_revoked",
    });
    expect(cockpitInstallationRefusal(revoked, { ...owner, user_id: "user-2" }).status).toBe(401);
    expect(cockpitInstallationRefusal(revoked, { ...owner, tenant_id: "tenant-2" }).status).toBe(
      401,
    );
  });
});
