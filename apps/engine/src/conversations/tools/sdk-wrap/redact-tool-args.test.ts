// #304 — targeted credential-arg scrub for the persisted tool-call row.
// Must mask known credential slots for known tools while leaving every other
// tool + arg byte-identical (the blanket-sweep-corrupts-workflow-code
// incident class, pinned in redaction-persist.integration.test.ts).

import { describe, expect, test } from "bun:test";

import { ELICITATION_REDACTED_MARKER as MARKER } from "../ask-user/redact-answer.ts";
import { redactToolArgsForPersist } from "./redact-tool-args.ts";

describe("redactToolArgsForPersist — save_connector_draft", () => {
  test("secret credential slots become the marker; non-secret slots intact", () => {
    const args = {
      slug: "acme",
      credential: { mode: "bearer", token: "sk-real-secret-value", note: "prod key" },
    };
    const out = redactToolArgsForPersist("save_connector_draft", args) as {
      slug: string;
      credential: Record<string, string>;
    };
    expect(out.credential.token).toBe(MARKER);
    expect(out.credential.mode).toBe("bearer");
    expect(out.credential.note).toBe("prod key");
    expect(out.slug).toBe("acme");
    // The caller's raw object is untouched (execution still needs it).
    expect(args.credential.token).toBe("sk-real-secret-value");
  });

  test("basic-auth password + aws secret_access_key are masked", () => {
    const out = redactToolArgsForPersist("save_connector_draft", {
      credential: {
        mode: "basic",
        username: "svc",
        password: "hunter2",
        secret_access_key: "AKIAsecretpart",
      },
    }) as { credential: Record<string, string> };
    expect(out.credential.username).toBe("svc");
    expect(out.credential.password).toBe(MARKER);
    expect(out.credential.secret_access_key).toBe(MARKER);
  });

  test("args with no credential subtree pass through by reference", () => {
    const args = { slug: "acme", base_url: "https://api.example.com" };
    expect(redactToolArgsForPersist("save_connector_draft", args)).toBe(args);
  });
});

describe("redactToolArgsForPersist — update_connector_draft (dotted config paths)", () => {
  test("config.api_key / config.token are masked, other config keys intact", () => {
    const args = {
      id: "conn-1",
      config: { api_key: "secret-key-abc", token: "secret-tok-def", base_url: "https://x.example" },
    };
    const out = redactToolArgsForPersist("update_connector_draft", args) as {
      config: Record<string, string>;
    };
    expect(out.config.api_key).toBe(MARKER);
    expect(out.config.token).toBe(MARKER);
    expect(out.config.base_url).toBe("https://x.example");
  });
});

describe("redactToolArgsForPersist — targeted, never blanket", () => {
  test("a non-credential tool's args pass through untouched (incl. base64 alphabet)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const args = {
      patches: [{ op: "replace", path: "/steps/0/expression", value: `const B="${alphabet}";` }],
    };
    // edit_workflow_patch declares no credentialFields → identity passthrough.
    expect(redactToolArgsForPersist("edit_workflow_patch", args)).toBe(args);
  });

  test("save_connector_draft with a high-entropy value in a NON-secret slot is left intact", () => {
    // Only SECRET_SEED_FIELDS slots are scrubbed — a base_url or client_id
    // that happens to look high-entropy must survive.
    const args = { credential: { mode: "oauth2", client_id: "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRs" } };
    const out = redactToolArgsForPersist("save_connector_draft", args) as {
      credential: Record<string, string>;
    };
    expect(out.credential.client_id).toBe("Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRs");
  });

  test("non-object args return unchanged", () => {
    expect(redactToolArgsForPersist("save_connector_draft", null)).toBeNull();
    expect(redactToolArgsForPersist("save_connector_draft", "x")).toBe("x");
  });
});
