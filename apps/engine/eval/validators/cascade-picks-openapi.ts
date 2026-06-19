// Integration-eval: cascade orchestrator picks the first successful source.

import { cascadeIngest } from "../../src/docs-ingestion/cascade.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  base_url: string;
  served_paths: Record<string, { status: number; body: unknown; content_type?: string }>;
  expect: { winning_source: string; min_chunks: number };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const fetchImpl = (async (url: unknown) => {
    const u = typeof url === "string" ? url : String(url);
    for (const [path, cfg] of Object.entries(input.served_paths)) {
      if (u.endsWith(path)) {
        return new Response(typeof cfg.body === "string" ? cfg.body : JSON.stringify(cfg.body), {
          status: cfg.status,
          headers: { "content-type": cfg.content_type ?? "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const res = await cascadeIngest({ base_url: input.base_url, fetchImpl });
  if (res.winning_source !== input.expect.winning_source) {
    return {
      pass: false,
      reason: `expected winning_source=${input.expect.winning_source}, got ${res.winning_source}`,
    };
  }
  if (res.chunks.length < input.expect.min_chunks) {
    return {
      pass: false,
      reason: `expected >=${input.expect.min_chunks} chunks, got ${res.chunks.length}`,
    };
  }
  return {
    pass: true,
    metrics: {
      chunks: res.chunks.length,
      attempts: res.attempts.length,
    },
  };
}
