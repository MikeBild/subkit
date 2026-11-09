import { expect, test } from "bun:test";
import { AUDIT_SOURCE_HEADER, AUDIT_SOURCE_VALUES, DEPLOY_VERSION_HEADER } from "./audit-source.ts";

test("settings write audit headers and enum retain the published HTTP vocabulary", () => {
  expect(AUDIT_SOURCE_HEADER).toBe("x-subkit-audit-source");
  expect(DEPLOY_VERSION_HEADER).toBe("x-subkit-deploy-version");
  expect(AUDIT_SOURCE_VALUES).toEqual(["sk_cli", "deploy_bootstrap"]);
});
