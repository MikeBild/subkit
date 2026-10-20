import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "./index.ts";
import { getRawResult } from "./truncate.ts";

const MAX_INLINE_CHARS = 12_000;
const DEFAULT_CHUNK_LIMIT = 24_000;
const MAX_CHUNK_LIMIT = 32_000;

const Input = z
  .object({
    ref: z.string().min(1),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(MAX_CHUNK_LIMIT).optional(),
  })
  .openapi("GetRawResultToolInput");

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function largeValuePaths(
  value: unknown,
  path: Array<string | number> = [],
): Array<{ path: Array<string | number>; chars: number }> {
  const size = sizeOf(value);
  if (size <= MAX_INLINE_CHARS) return [];
  if (typeof value === "string") return [{ path, chars: value.length }];

  const entries = Array.isArray(value)
    ? value.map((entry, index) => [index, entry] as const)
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];
  const children = entries.flatMap(([key, entry]) => largeValuePaths(entry, [...path, key]));
  return children.length > 0 ? children : [{ path, chars: size }];
}

function atPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") {
      current = current[part];
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      typeof part !== "string" ||
      !Object.hasOwn(current, part)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const MAX_LISTED_KEYS = 50;

function topLevelShape(value: unknown): { available_keys: string[] } | { total_items: number } {
  if (Array.isArray(value)) return { total_items: value.length };
  if (value === null || typeof value !== "object") return { available_keys: [] };
  return { available_keys: Object.keys(value).slice(0, MAX_LISTED_KEYS) };
}

function tooLarge(value: unknown, path: Array<string | number>, totalChars: number) {
  return {
    ok: false,
    data: {
      error: "raw_result_too_large",
      total_chars: totalChars,
      fields: largeValuePaths(value, path).slice(0, 12),
      hint: "The result is too large to read at once. Read a listed field a section at a time using path, offset, and limit. Continue until next_offset is null, then explain the useful findings in plain language without mentioning these retrieval details.",
    },
  };
}

export const getRawResultTool: ConversationTool = {
  name: "get_raw_result",
  description:
    "Retrieve a prior tool result by its `raw_ref`. Small results are returned whole. For a large result, read a listed field a section at a time with path, offset, and limit, continuing until next_offset is null. Summarize the useful findings for the user in plain language; do not expose retrieval details.",
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const raw = getRawResult(
      args.ref,
      ctx.tenant_id && (ctx.raw_result_scope_id ?? ctx.conversation_id)
        ? {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.raw_result_scope_id ?? ctx.conversation_id,
            actor_id: ctx.principal?.id ?? ctx.actor_id ?? null,
          }
        : null,
    );
    if (raw === undefined) {
      return {
        ok: false,
        data: {
          error: "raw_ref_not_found",
          hint: "The reference is unavailable to this caller and conversation, or it expired. Re-run the original authorized tool call for a fresh reference, then read it in the same scope.",
        },
      };
    }

    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_CHUNK_LIMIT;
    const selected = args.path === undefined ? raw : atPath(raw, args.path);
    if (selected === undefined) {
      return {
        ok: false,
        data: {
          error: "raw_result_path_not_found",
          path: args.path ?? [],
          ...topLevelShape(raw),
        },
      };
    }

    if (typeof selected === "string") {
      if (args.path === undefined && selected.length > MAX_INLINE_CHARS) {
        return tooLarge(raw, [], selected.length);
      }
      if (args.path !== undefined) {
        const characters = Array.from(selected);
        if (offset > characters.length) {
          return {
            ok: false,
            data: {
              error: "raw_result_offset_out_of_range",
              offset,
              total_chars: characters.length,
            },
          };
        }
        const chunk = characters.slice(offset, offset + limit).join("");
        const nextOffset = offset + Array.from(chunk).length;
        return {
          ok: true,
          data: {
            raw: chunk,
            path: args.path,
            offset,
            total_chars: characters.length,
            next_offset: nextOffset < characters.length ? nextOffset : null,
          },
        };
      }
    }

    if (Array.isArray(selected) && sizeOf(selected) > MAX_INLINE_CHARS) {
      if (offset > selected.length) {
        return {
          ok: false,
          data: { error: "raw_result_offset_out_of_range", offset, total_items: selected.length },
        };
      }
      const chunk: unknown[] = [];
      let chunkChars = 2;
      for (
        let index = offset;
        index < selected.length && chunk.length < Math.min(limit, 100);
        index++
      ) {
        const entry = selected[index];
        if (entry === undefined) break;
        const entryChars = sizeOf(entry) + (chunk.length > 0 ? 1 : 0);
        if (chunk.length === 0 && entryChars + 2 > MAX_INLINE_CHARS) {
          return tooLarge(entry, [...(args.path ?? []), index], entryChars);
        }
        if (chunkChars + entryChars > MAX_INLINE_CHARS) break;
        chunk.push(entry);
        chunkChars += entryChars;
      }
      const nextOffset = offset + chunk.length;
      return {
        ok: true,
        data: {
          raw: chunk,
          path: args.path ?? [],
          offset,
          total_items: selected.length,
          next_offset: nextOffset < selected.length ? nextOffset : null,
        },
      };
    }

    const totalChars = sizeOf(selected);
    if (totalChars > MAX_INLINE_CHARS) {
      return tooLarge(selected, args.path ?? [], totalChars);
    }
    return { ok: true, data: { raw: selected } };
  },
};
