import type { Executor } from "../db/client.ts";
import {
  provisionSelfServiceTenant,
  type WorkspaceRegistration,
} from "../identity/self-service.ts";

export const TEST_WORKSPACE_REGISTRATION: WorkspaceRegistration = {
  display_name: "Test Owner",
  workspace_name: "Test workspace",
  timezone: "UTC",
};

export function provisionTestWorkspace(subject: string, db: Executor) {
  return provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    db,
  );
}
