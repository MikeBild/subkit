import { expect, test } from "bun:test";
import {
  browserSessionCookie,
  browserSessionFromRequest,
  canonicalBrowserPath,
  clearBrowserSessionCookie,
  cockpitInstallationSessionCookie,
  signBrowserSession,
} from "./browser-session.ts";

const installationId = "11111111-1111-4111-8111-111111111111";
const payload = {
  session_id: "22222222-2222-4222-8222-222222222222",
  user_id: "33333333-3333-4333-8333-333333333333",
  tenant_id: "44444444-4444-4444-8444-444444444444",
  installation_id: installationId,
};

test("installation sessions use an exact path cookie and never fall back to root", async () => {
  const jwt = await signBrowserSession(payload);
  const cookie = browserSessionCookie(jwt, undefined, installationId);
  expect(cookie).toContain(`${cockpitInstallationSessionCookie(installationId)}=`);
  expect(cookie).toContain(`Path=/cockpit/i/${installationId}/`);

  const appRequest = new Request(
    `https://subkit.test/cockpit/i/${installationId}/api/v1/cockpit/bootstrap`,
    {
      headers: { cookie },
    },
  );
  expect(await browserSessionFromRequest(appRequest)).toEqual(payload);

  const rootRequest = new Request("https://subkit.test/v1/cockpit/bootstrap", {
    headers: { cookie },
  });
  expect(await browserSessionFromRequest(rootRequest)).toBeNull();
  expect(clearBrowserSessionCookie(installationId)).toContain(`Path=/cockpit/i/${installationId}/`);
});

test("installation route canonicalization preserves the API handler path", () => {
  expect(
    canonicalBrowserPath(
      `https://subkit.test/cockpit/i/${installationId}/api/v1/identity/tenant-session`,
    ),
  ).toBe("/v1/identity/tenant-session");
  expect(
    canonicalBrowserPath("https://subkit.test/cockpit/i/not-a-uuid/api/v1/cockpit/bootstrap"),
  ).toBe("/cockpit/i/not-a-uuid/api/v1/cockpit/bootstrap");
});
