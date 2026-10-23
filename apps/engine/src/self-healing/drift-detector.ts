import { deriveShape, diffShapes } from "../schema-versions/service.ts";
import type { DriftSignal, SchemaShape } from "./types.ts";

export interface FailingStepSnapshot {
  id: string;
  step_key?: string;
  kind: string;
  status: string;
  error?: unknown;
  request_meta?: import("../execution/types.ts").RequestMeta | null;
  output_preview?: unknown;
  expression?: string;
}

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function extractRequestFromMeta(
  meta: import("../execution/types.ts").RequestMeta | null | undefined,
): { method?: string | undefined; url?: string | undefined; path?: string | undefined } {
  if (!meta) return {};
  const driver = (meta as { driver?: string }).driver;
  switch (driver) {
    case "http":
    case "connectorless": {
      const m = meta as { method?: string; url?: string | null };
      return {
        ...(typeof m.method === "string" ? { method: m.method } : {}),
        ...(typeof m.url === "string" ? { url: m.url } : {}),
      };
    }
    case "graphql": {
      const m = meta as { method?: string };
      return { ...(typeof m.method === "string" ? { method: m.method } : {}) };
    }
    case "s3": {
      const m = meta as { method?: string };
      return { ...(typeof m.method === "string" ? { method: m.method } : {}) };
    }
    case "postgres": {
      const m = meta as { query_preview?: string };
      return {
        ...(typeof m.query_preview === "string" ? { path: m.query_preview } : {}),
      };
    }
    case "error": {
      const m = meta as { method?: string; url?: string | null };
      return {
        ...(typeof m.method === "string" ? { method: m.method } : {}),
        ...(typeof m.url === "string" ? { url: m.url } : {}),
      };
    }
    default: {
      const obj = asObj(meta) ?? {};
      return {
        ...(typeof obj.method === "string" ? { method: obj.method as string } : {}),
        ...(typeof obj.url === "string" ? { url: obj.url as string } : {}),
        ...(typeof obj.path === "string" ? { path: obj.path as string } : {}),
      };
    }
  }
}

export function analyzeStepFailure(
  step: FailingStepSnapshot,
  lastKnownShape: SchemaShape | null,
): DriftSignal | null {
  const err = asObj(step.error);
  if (!err) return null;

  if (err.code === "validation_failed") {
    const details = asObj(err.details);
    const expression = typeof details?.expression === "string" ? details.expression : "";
    if (expression) {
      return {
        kind: "validation_failed",
        expression,
        actual_value: details?.actual_value ?? null,
      };
    }
  }

  if (err.kind === "jsonata_miss" || err.kind === "jsonata_path_miss") {
    const expression =
      typeof err.expression === "string" ? err.expression : (step.expression ?? "");
    const missing_path = typeof err.missing_path === "string" ? err.missing_path : "";
    if (expression && missing_path) {
      return {
        kind: "jsonata_path_miss",
        expression,
        missing_path,
        prior_value: err.prior_value ?? null,
      };
    }
  }

  if (err.kind === "graphql_schema_error") {
    const details = asObj(err.details);
    const rootField = typeof details?.root_field === "string" ? details.root_field : null;
    const opName =
      typeof details?.operation_name === "string" && details.operation_name.length > 0
        ? details.operation_name
        : null;
    const path = rootField ?? opName;
    return {
      kind: "endpoint_contract",
      severity: "removed",
      request: { method: "POST", ...(path ? { path } : {}) },
      sunset: null,
      successor_uri: null,
    };
  }

  if (err.kind === "http") {
    const statusRaw = err.status;
    const status =
      typeof statusRaw === "number" ? statusRaw : Number.parseInt(String(statusRaw), 10);
    const body = err.body;
    if (Number.isFinite(status) && status >= 400 && body !== undefined) {
      const after = deriveShape(body);
      if (lastKnownShape && !shapesEqual(lastKnownShape, after)) {
        const request = extractRequestFromMeta(step.request_meta);
        return {
          kind: "http_status_new_shape",
          status,
          request,
          response_before: lastKnownShape,
          response_after: after,
        };
      }
    }
  }

  if (lastKnownShape) {
    const captured = err.captured_response ?? step.output_preview;
    if (captured !== undefined) {
      const after = deriveShape(captured);
      if (!shapesEqual(lastKnownShape, after)) {
        const { added, removed, widened } = diffShapes(lastKnownShape, after);
        if (added.length + removed.length + widened.length > 0) {
          return {
            kind: "schema_diff",
            before: lastKnownShape,
            after,
            added,
            removed,
            widened,
          };
        }
      }
    }
  }

  return null;
}

export function hasFieldLevelChange(before: SchemaShape, after: SchemaShape): boolean {
  if (before.type === "unknown" || after.type === "unknown") return false;
  if (before.type !== after.type) return true;
  if (before.type === "array" && after.type === "array")
    return hasFieldLevelChange(before.items, after.items);
  if (before.type !== "object" || after.type !== "object") return false;
  const beforeKeys = Object.keys(before.properties);
  const afterKeys = Object.keys(after.properties);
  if (afterKeys.some((key) => !(key in before.properties))) return true;
  if (beforeKeys.some((key) => !(key in after.properties))) return true;
  return beforeKeys.some((key) => {
    const b = before.properties[key];
    const a = after.properties[key];
    return b !== undefined && a !== undefined && hasFieldLevelChange(b, a);
  });
}

export function renderDriftDiff(signal: DriftSignal): string {
  switch (signal.kind) {
    case "jsonata_path_miss":
      return [
        `kind: jsonata_path_miss`,
        `expression: ${signal.expression}`,
        `missing_path: ${signal.missing_path}`,
      ].join("\n");
    case "http_status_new_shape": {
      const lines: string[] = [`kind: http_status_new_shape`, `status: ${signal.status}`];
      if (signal.request.method) lines.push(`request.method: ${signal.request.method}`);
      if (signal.request.url) lines.push(`request.url: ${signal.request.url}`);
      if (signal.request.path) lines.push(`request.path: ${signal.request.path}`);
      lines.push(`before: ${JSON.stringify(signal.response_before)}`);
      lines.push(`after: ${JSON.stringify(signal.response_after)}`);
      return lines.join("\n");
    }
    case "schema_diff":
      return [
        `kind: schema_diff`,
        `added: ${signal.added.join(", ") || "(none)"}`,
        `removed: ${signal.removed.join(", ") || "(none)"}`,
        `widened: ${signal.widened.join(", ") || "(none)"}`,
      ].join("\n");
    case "stdlib_version_drift":
      return [
        `kind: stdlib_version_drift`,
        `surface: ${signal.surface}`,
        `resource_id: ${signal.resource_id}`,
        `recorded_version: ${signal.recorded_version}`,
        `current_version: ${signal.current_version}`,
      ].join("\n");
    case "validation_failed":
      return [
        `kind: validation_failed`,
        `expression: ${signal.expression}`,
        `actual_value: ${JSON.stringify(signal.actual_value)}`,
      ].join("\n");
    case "endpoint_contract": {
      const lines: string[] = [`kind: endpoint_contract`, `severity: ${signal.severity}`];
      if (signal.request.method) lines.push(`request.method: ${signal.request.method}`);
      if (signal.request.url) lines.push(`request.url: ${signal.request.url}`);
      if (signal.request.path) lines.push(`request.path: ${signal.request.path}`);
      if (signal.sunset) lines.push(`sunset: ${signal.sunset}`);
      if (signal.successor_uri) lines.push(`successor_uri: ${signal.successor_uri}`);
      return lines.join("\n");
    }
    case "gate_block":
      return [
        `kind: gate_block`,
        `code: ${signal.code}`,
        `reason: ${signal.reason ?? "(none)"}`,
        `fixer: ${signal.fixer}`,
        `step_id: ${signal.step_id}`,
      ].join("\n");
  }
}

function shapesEqual(a: SchemaShape, b: SchemaShape): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "object" && b.type === "object") {
    const aKeys = Object.keys(a.properties);
    const bKeys = Object.keys(b.properties);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      const av = a.properties[k];
      const bv = b.properties[k];
      if (!bv || !av) return false;
      if (!shapesEqual(av, bv)) return false;
    }
    return true;
  }
  if (a.type === "array" && b.type === "array") {
    return shapesEqual(a.items, b.items);
  }
  return true;
}
