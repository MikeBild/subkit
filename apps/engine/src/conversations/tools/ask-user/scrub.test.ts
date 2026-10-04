import { describe, expect, test } from "bun:test";
import { scrubAskUserPayload } from "./common.ts";

const FAKE_TOKEN = "ATATTexampleexampleexample123Aa456";
const MARKER = "***REDACTED:pat***";

describe("scrubAskUserPayload", () => {
  test("scrubs a secret echoed into summary and every nested input leaf", () => {
    const out = scrubAskUserPayload({
      tool_name: "ask_user_form",
      summary: `Confirm the Jira token ${FAKE_TOKEN} I found`,
      input: {
        question: `Is ${FAKE_TOKEN} still valid?`,
        fields: [
          {
            name: "token",
            type: "password",
            label: `Token (${FAKE_TOKEN})`,
            placeholder: `e.g. ${FAKE_TOKEN}`,
            default: FAKE_TOKEN,
          },
          {
            name: "envs",
            type: "select",
            default: [FAKE_TOKEN, "prod"],
            options: [{ value: "a", label: `env with ${FAKE_TOKEN}` }],
          },
        ],
      },
    });

    expect(out.tool_name).toBe("ask_user_form");
    expect(out.summary).toBe(`Confirm the Jira token ${MARKER} I found`);
    const input = out.input as unknown as {
      question: string;
      fields: [
        { name: string; label: string; placeholder: string; default: string },
        { default: string[]; options: Array<{ label: string }> },
      ];
    };
    expect(input.question).toBe(`Is ${MARKER} still valid?`);
    expect(input.fields[0].label).toBe(`Token (${MARKER})`);
    expect(input.fields[0].placeholder).toBe(`e.g. ${MARKER}`);
    expect(input.fields[0].default).toBe(MARKER);
    expect(input.fields[1].default).toEqual([MARKER, "prod"]);
    expect(input.fields[1].options[0]!.label).toBe(`env with ${MARKER}`);
    expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
  });

  test("commit_intent payload keeps key names and Mustache values intact", () => {
    const out = scrubAskUserPayload({
      tool_name: "ask_user_form",
      summary: "Provide the connector credential",
      input: {
        question: "Paste your API token",
        fields: [{ name: "token", type: "password", label: "API token" }],
        commit_intent: {
          kind: "connector_credential",
          payload: { credential: { token: "{{token}}", header: "Bearer {{token}}" } },
        },
      },
    });
    const input = out.input as {
      commit_intent: { payload: { credential: { token: string; header: string } } };
    };
    expect(input.commit_intent.payload.credential.token).toBe("{{token}}");
    expect(input.commit_intent.payload.credential.header).toBe("Bearer {{token}}");
  });

  test("clean payloads pass through unchanged", () => {
    const p = {
      tool_name: "ask_user_choice",
      summary: "Pick a schedule cadence",
      input: { question: "How often?", options: ["hourly", "daily"] },
    };
    expect(scrubAskUserPayload(p)).toEqual(p);
  });
});
