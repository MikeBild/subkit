import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { changedFieldsDescription, unverifiedApiKeyClient } from "./audit-timeline";
import type { TimelineEntry } from "./audit-timeline-model";

describe("Audit details", () => {
  test("states the API client cannot be verified from an ordinary key or a reported user agent", () => {
    expect(
      unverifiedApiKeyClient({
        access_type: "api_key",
        api_key_id: "key-a",
        credential_origin: null,
        origin_source: "api",
        user_agent: "sk-cli/1.0",
      } as TimelineEntry),
    ).toBe(true);
    expect(
      unverifiedApiKeyClient({
        access_type: "api_key",
        api_key_id: "key-a",
        credential_origin: "cli_oauth_session",
        origin_source: "api",
        user_agent: "HTTP client",
      } as TimelineEntry),
    ).toBe(false);
    expect(
      unverifiedApiKeyClient({
        access_type: "api_key",
        api_key_id: "key-a",
        credential_origin: null,
        origin_source: "mcp",
        user_agent: "sk-cli/1.0",
      } as TimelineEntry),
    ).toBe(false);
    expect(translate("de", "audit.timeline.clientApplication.unverifiedApiKey")).toContain(
      "Nicht verifiziert",
    );
    expect(translate("en", "audit.timeline.clientApplication.unverifiedApiKey")).toContain(
      "Unverified",
    );
  });

  test("renders translated field names together with their exact audit identifiers", () => {
    const fields = ["name", "status", "filename", "internal_field"];
    expect(changedFieldsDescription(fields, (key) => translate("de", key))).toBe(
      "Name (name), Zustand (status), Dateiname (filename), Weiteres Feld (internal_field)",
    );
    expect(changedFieldsDescription(fields, (key) => translate("en", key))).toBe(
      "Name (name), State (status), File name (filename), Other field (internal_field)",
    );
  });
});
