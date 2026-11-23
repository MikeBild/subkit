import { z } from "@hono/zod-openapi";
import type { RawResultScope } from "../../tools/truncate.ts";
import { getRawResult, rememberRaw, withRawResultScope } from "../../tools/truncate.ts";
import { summarizeScopeShape } from "../../workflows/scope-shape.ts";
import type { ConversationTool } from "./index.ts";

const MAX_INLINE_CHARS = 12_000;
const DEFAULT_CHUNK_LIMIT = 24_000;
const MAX_CHUNK_LIMIT = 32_000;
const REF_ONLY_CHUNK_CHARS = 4_000;
const STREAM_CURSOR = Symbol("raw-result-stream-cursor");
const OFFSET_OUT_OF_RANGE_MESSAGE =
  "the offset is past the end of the stored value; restart at offset 0 or follow next_offset";

type StreamCursor = {
  [STREAM_CURSOR]: { source_ref: string; offset: number };
};

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
const MAX_FIELD_SHAPES = 20;
const MAX_SUGGESTED_PATHS = 10;
const MAX_LEAF_DEPTH = 6;

function topLevelShape(value: unknown): { available_keys: string[] } | { total_items: number } {
  if (Array.isArray(value)) return { total_items: value.length };
  if (value === null || typeof value !== "object") return { available_keys: [] };
  return { available_keys: Object.keys(value).slice(0, MAX_LISTED_KEYS) };
}

function shapeOf(value: unknown): { shape: string; field_shapes?: Record<string, string> } {
  const shape = summarizeScopeShape(value);
  const entries = Array.isArray(value)
    ? value.slice(0, 1).map((entry, index) => [String(index), entry] as const)
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).slice(0, MAX_FIELD_SHAPES)
      : [];
  if (entries.length === 0) return { shape };
  return {
    shape,
    field_shapes: Object.fromEntries(
      entries.map(([key, child]) => [key, summarizeScopeShape(child)]),
    ),
  };
}

function suggestedPaths(
  value: unknown,
  prefix: Array<string | number> = [],
): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [];
  const walk = (node: unknown, path: Array<string | number>, depth: number): void => {
    if (out.length >= MAX_SUGGESTED_PATHS) return;
    const children = Array.isArray(node)
      ? node.slice(0, 1).map((entry, index) => [index, entry] as const)
      : node && typeof node === "object"
        ? Object.entries(node as Record<string, unknown>)
        : [];
    if (children.length === 0 || depth >= MAX_LEAF_DEPTH) {
      if (path.length > prefix.length) out.push(path);
      return;
    }
    for (const [key, child] of children) walk(child, [...path, key], depth + 1);
  };
  walk(value, prefix, 0);
  return out;
}

function tooLarge(value: unknown, path: Array<string | number>, totalChars: number) {
  return {
    ok: false,
    data: {
      error: "raw_result_too_large",
      error_code: "raw_result_too_large",
      message:
        "The result is too large to read at once. Read a listed field a section at a time using path, offset, and limit. Continue until next_offset is null, then explain the useful findings in plain language without mentioning these retrieval details.",
      next_best_actions: ["get_raw_result"],
      total_chars: totalChars,
      fields: largeValuePaths(value, path).slice(0, 12),
      ...shapeOf(value),
      suggested_paths: suggestedPaths(value, path),
    },
  };
}

function streamCursor(value: unknown): StreamCursor[typeof STREAM_CURSOR] | null {
  if (value === null || typeof value !== "object") return null;
  return STREAM_CURSOR in value ? (value as StreamCursor)[STREAM_CURSOR] : null;
}

function rememberInScope(value: unknown, scope: RawResultScope | null): string {
  return scope ? withRawResultScope(scope, () => rememberRaw(value)) : rememberRaw(value);
}

export const getRawResultTool: ConversationTool = {
  name: "get_raw_result",
  external_output: "connector",
  description:
    "Retrieve a prior tool result by its `raw_ref`. Small results are returned whole. For a large result, either read a field with path, offset, and limit or follow the returned next_ref with ref-only calls until next_ref is null. Summarize the useful findings for the user in plain language; do not expose retrieval details.",
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const scope =
      ctx.tenant_id && (ctx.raw_result_scope_id ?? ctx.conversation_id)
        ? {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.raw_result_scope_id ?? ctx.conversation_id,
            actor_id: ctx.principal?.id ?? ctx.actor_id ?? null,
          }
        : null;
    const stored = getRawResult(args.ref, scope);
    const cursor = streamCursor(stored);
    const sourceRef = cursor?.source_ref ?? args.ref;
    const raw = cursor ? getRawResult(sourceRef, scope) : stored;
    if (raw === undefined) {
      return {
        ok: false,
        data: {
          error: "raw_ref_not_found",
          error_code: "raw_ref_not_found",
          next_best_actions: [],
          message:
            "The reference is unavailable to this caller and conversation, or it expired. Re-run the original authorized tool call for a fresh reference, then read it in the same scope.",
        },
      };
    }

    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_CHUNK_LIMIT;
    if (args.path === undefined && sizeOf(raw) > MAX_INLINE_CHARS) {
      const serialized = JSON.stringify(raw);
      const characters = Array.from(serialized);
      const streamOffset = args.offset ?? cursor?.offset ?? 0;
      if (streamOffset > characters.length) {
        return {
          ok: false,
          data: {
            error: "raw_result_offset_out_of_range",
            error_code: "raw_result_offset_out_of_range",
            message: OFFSET_OUT_OF_RANGE_MESSAGE,
            next_best_actions: ["get_raw_result"],
            offset: streamOffset,
            total_chars: characters.length,
          },
        };
      }
      const chunk = characters.slice(streamOffset, streamOffset + REF_ONLY_CHUNK_CHARS).join("");
      const nextOffset = streamOffset + Array.from(chunk).length;
      const nextRef =
        nextOffset < characters.length
          ? rememberInScope(
              { [STREAM_CURSOR]: { source_ref: sourceRef, offset: nextOffset } },
              scope,
            )
          : null;
      return {
        ok: true,
        data: {
          raw: chunk,
          encoding: "json_fragment",
          offset: streamOffset,
          total_chars: characters.length,
          next_ref: nextRef,
        },
      };
    }
    const selected = args.path === undefined ? raw : atPath(raw, args.path);
    if (selected === undefined) {
      return {
        ok: false,
        data: {
          error: "raw_result_path_not_found",
          error_code: "raw_result_path_not_found",
          message:
            "Nothing is stored at this path. Retry get_raw_result with one of suggested_paths or a key from the shape.",
          next_best_actions: ["get_raw_result"],
          path: args.path ?? [],
          ...topLevelShape(raw),
          ...shapeOf(raw),
          suggested_paths: suggestedPaths(raw),
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
              error_code: "raw_result_offset_out_of_range",
              message: OFFSET_OUT_OF_RANGE_MESSAGE,
              next_best_actions: ["get_raw_result"],
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
          data: {
            error: "raw_result_offset_out_of_range",
            error_code: "raw_result_offset_out_of_range",
            message: OFFSET_OUT_OF_RANGE_MESSAGE,
            next_best_actions: ["get_raw_result"],
            offset,
            total_items: selected.length,
          },
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
