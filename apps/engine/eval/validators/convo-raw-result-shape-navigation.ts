import { getRawResultTool } from "../../src/conversations/tools/get-raw-result.ts";
import {
  clearRawStore,
  rememberRaw,
  withRawResultScope,
} from "../../src/conversations/tools/truncate.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks } from "./shared/authoring-env.ts";
import { makeOfflineToolCtx } from "./shared/offline-tool-ctx.ts";

type PathPart = string | number;

interface Input {
  message_count: number;
  body_chars: number;
  wrong_path: PathPart[];
  oversized_path: PathPart[];
  expect: {
    path_not_found_code: string;
    too_large_code: string;
    suggested_prefix: PathPart[];
    max_calls_to_value: number;
  };
}

interface Refusal {
  error?: string;
  error_code?: string;
  shape?: unknown;
  suggested_paths?: PathPart[][];
  next_best_actions?: string[];
}

function mailbox(input: Input): Record<string, unknown> {
  return {
    data: {
      messages: Array.from({ length: input.message_count }, (_, index) => ({
        id: `msg-${index}`,
        thread_id: `thread-${index}`,
        payload: {
          headers: [{ name: "Subject", value: `Weekly summary ${index}` }],
          body: { size: input.body_chars, data: "x".repeat(input.body_chars) },
        },
      })),
      next_page_token: "page-2",
    },
  };
}

function startsWith(path: PathPart[], prefix: PathPart[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const ctx = makeOfflineToolCtx("raw_result_navigation");
  clearRawStore();
  try {
    const scope = {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      actor_id: ctx.actor_id,
    };
    const ref = withRawResultScope(scope, () => rememberRaw(mailbox(input)));
    let calls = 0;

    const read = async (path: PathPart[]) => {
      calls += 1;
      return getRawResultTool.execute(ctx, { ref, path });
    };

    const scenarios: Array<{ label: string; path: PathPart[]; code: string }> = [
      { label: "wrong path", path: input.wrong_path, code: input.expect.path_not_found_code },
      { label: "oversized field", path: input.oversized_path, code: input.expect.too_large_code },
    ];

    for (const scenario of scenarios) {
      calls = 0;
      const refused = await read(scenario.path);
      const data = (refused.data ?? {}) as Refusal;
      c.check(!refused.ok, `${scenario.label}: expected a refusal, got ok`);
      c.check(
        data.error_code === scenario.code || data.error === scenario.code,
        `${scenario.label}: code ${data.error_code ?? data.error} != ${scenario.code}`,
      );
      c.check(data.shape !== undefined, `${scenario.label}: refusal carries no shape`);
      const suggested = Array.isArray(data.suggested_paths) ? data.suggested_paths : [];
      c.check(suggested.length > 0, `${scenario.label}: refusal carries no suggested_paths`);
      c.check(
        (data.next_best_actions ?? []).includes("get_raw_result"),
        `${scenario.label}: next_best_actions does not point back at get_raw_result`,
      );
      const target = suggested.find((path) => startsWith(path, input.expect.suggested_prefix));
      c.check(
        target !== undefined,
        `${scenario.label}: no suggested path under ${JSON.stringify(input.expect.suggested_prefix)}: ${JSON.stringify(suggested.slice(0, 4))}`,
      );
      if (!target) continue;
      const followed = await read(target);
      c.check(
        followed.ok,
        `${scenario.label}: following suggested path ${JSON.stringify(target)} failed: ${JSON.stringify(followed.data).slice(0, 200)}`,
      );
      c.check(
        calls <= input.expect.max_calls_to_value,
        `${scenario.label}: reached the value in ${calls} calls, budget ${input.expect.max_calls_to_value}`,
      );
    }
  } finally {
    clearRawStore();
  }
  c.check(ctx.dbAccesses() === 0, `raw result navigation touched the database`);
  if (c.failed) return { pass: false, reason: c.failed };
  return { pass: true };
}
