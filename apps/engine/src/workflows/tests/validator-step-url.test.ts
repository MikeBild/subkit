// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal placeholder fixtures
import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

describe("validateWorkflowDef · request step.url shapes", () => {
  test("absolute https URL is accepted", () => {
    const r = validateWorkflowDef(
      {
        name: "wf",
        steps: [
          {
            id: "s",
            kind: "request",
            method: "GET",
            url: "https://api.github.com/user/repos",
          },
        ],
      },
      { allowForwardRefs: true },
    );
    expect(r.ok).toBe(true);
  });

  test("${connector.<slug>.base_url}/<path> placeholder is accepted", () => {
    const r = validateWorkflowDef(
      {
        name: "wf",
        steps: [
          {
            id: "s",
            kind: "request",
            method: "GET",
            url: "${connector.github-api.base_url}/user/repos",
          },
        ],
      },
      { allowForwardRefs: true },
    );
    expect(r.ok).toBe(true);
  });

  test("bare ${connector.<slug>.base_url} (no trailing path) is accepted", () => {
    const r = validateWorkflowDef(
      {
        name: "wf",
        steps: [
          {
            id: "s",
            kind: "request",
            method: "GET",
            url: "${connector.github-api.base_url}",
          },
        ],
      },
      { allowForwardRefs: true },
    );
    expect(r.ok).toBe(true);
  });

  test("other ${...} placeholders in url are rejected", () => {
    const r = validateWorkflowDef(
      {
        name: "wf",
        steps: [
          {
            id: "s",
            kind: "request",
            method: "GET",
            url: "${cred.github.token}/user/repos",
          },
        ],
      },
      { allowForwardRefs: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.path).toBe("steps.s.url");
  });

  test("non-http relative path in url is rejected", () => {
    const r = validateWorkflowDef(
      {
        name: "wf",
        steps: [{ id: "s", kind: "request", method: "GET", url: "/user/repos" }],
      },
      { allowForwardRefs: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.path).toBe("steps.s.url");
  });
});
