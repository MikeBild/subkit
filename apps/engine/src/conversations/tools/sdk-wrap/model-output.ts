import { type UntrustedSource, wrapUntrusted } from "@shared/untrusted-content.ts";
import type { JSONValue } from "ai";
import { externalOutputSource, frameExternalResult } from "../../core/external-output.ts";
import { getTool } from "../index.ts";

type ModelOutput = { type: "json"; value: JSONValue };

export function toolModelOutput(
  tool: string,
  declared?: UntrustedSource,
): (result: { output: unknown }) => ModelOutput {
  const source = externalOutputSource(tool, declared);
  return ({ output }) => ({ type: "json", value: frameExternalResult(source, output) });
}

export function replayedToolOutput(
  tool: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const source = externalOutputSource(tool, getTool(tool)?.external_output);
  return source === null ? value : wrapUntrusted(source, value);
}
