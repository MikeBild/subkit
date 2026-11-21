import { isDeepStrictEqual } from "node:util";
import type { BoundaryGrowth } from "../authority-growth.ts";
import type { WorkflowEffectManifest } from "../effect-manifest.ts";
import { type ReadInheritanceEvidence, readEffectInherits } from "../read-inheritance.ts";
import { deviceGrowth } from "./device-growth.ts";
import { newVaultUses } from "./vault-uses.ts";

type Effect = WorkflowEffectManifest["effects"][number];

const COVERING_EFFECTS: Readonly<
  Record<Exclude<Effect["effect"], "unknown">, readonly Effect["effect"][]>
> = {
  read: ["read", "write", "destructive"],
  write: ["write", "destructive"],
  destructive: ["destructive"],
};

function effectCovered(next: Effect, granted: Effect): boolean {
  if (next.effect === "unknown")
    return granted.effect === "unknown" && next.operation === granted.operation;
  return COVERING_EFFECTS[next.effect].includes(granted.effect);
}

const SUB_BOUNDARIES = [
  "transactional_delivery",
  "outbox_delivery",
  "report_delivery",
  "content_publication",
  "read_path",
  "storage",
  "boundary",
  "read_query",
  "mcp",
] as const;

function sameConfiguration(next: Effect, granted: Effect): boolean {
  return (
    next.configuration_digest === granted.configuration_digest &&
    next.credential_binding_digest === granted.credential_binding_digest &&
    next.rewrites_target === granted.rewrites_target &&
    SUB_BOUNDARIES.every((key) => isDeepStrictEqual(next[key], granted[key]))
  );
}

export function projectBoundaryGrowth(
  granted: WorkflowEffectManifest,
  next: WorkflowEffectManifest,
  evidence?: ReadInheritanceEvidence,
  existingRelaxed: ReadonlyMap<string, readonly string[]> = new Map(),
): { growth: BoundaryGrowth[]; relaxed: Map<string, string[]> } {
  const growth = new Map<string, BoundaryGrowth>();
  const relaxed = new Map<string, string[]>();
  const add = (kind: BoundaryGrowth["kind"], effect: Effect) => {
    const entry = {
      kind,
      connector_id: effect.connector_id,
      target: effect.target,
      effect: effect.effect,
    };
    growth.set(JSON.stringify(entry), entry);
  };
  const grantedDevices = new Set(granted.effects.map((effect) => effect.device?.device_id));
  const grantedBindings = granted.effects.map((effect) => effect.device);
  const grantedSecrets = granted.effects.map((effect) => effect.secrets);
  for (const effect of next.effects) {
    for (const item of newVaultUses(effect.secrets, grantedSecrets)) {
      const entry = {
        kind: "new_secret" as const,
        connector_id: effect.connector_id,
        target: effect.target,
        effect: effect.effect,
        item,
      };
      growth.set(JSON.stringify(entry), entry);
    }
    if (effect.device && !grantedDevices.has(effect.device.device_id)) {
      const entry = {
        kind: "new_device" as const,
        connector_id: effect.connector_id,
        target: effect.target,
        effect: effect.effect,
        device_id: effect.device.device_id,
      };
      growth.set(JSON.stringify(entry), entry);
      continue;
    }
    if (effect.device)
      for (const { kind, item } of deviceGrowth(effect.device, grantedBindings)) {
        const entry = {
          kind,
          connector_id: effect.connector_id,
          target: effect.target,
          effect: effect.effect,
          device_id: effect.device.device_id,
          item,
        };
        growth.set(JSON.stringify(entry), entry);
      }
    const sameConnector = granted.effects.filter(
      (candidate) =>
        candidate.connector_id === effect.connector_id &&
        candidate.driver === effect.driver &&
        candidate.environment === effect.environment,
    );
    if (sameConnector.length === 0) {
      add(effect.connector_id ? "new_connector" : "new_target", effect);
      continue;
    }
    const sameTarget = sameConnector.filter((candidate) => candidate.target === effect.target);
    if (sameTarget.length === 0) {
      add("new_target", effect);
      continue;
    }
    const sameShape = sameTarget.flatMap((candidate) => {
      const read =
        evidence && effect.mcp === undefined && candidate.mcp === undefined
          ? readEffectInherits(effect, candidate, evidence, SUB_BOUNDARIES)
          : null;
      if (read === null)
        return sameConfiguration(effect, candidate) ? [{ candidate, keys: [] }] : [];
      return read ? [{ candidate, keys: read.relaxed }] : [];
    });
    if (sameShape.length === 0) {
      add("changed_boundary", effect);
      continue;
    }
    const covering = sameShape.filter((shape) => effectCovered(effect, shape.candidate));
    if (covering.length === 0) {
      add("wider_effect", effect);
      continue;
    }
    const keys = covering.reduce((a, b) => (b.keys.length < a.keys.length ? b : a)).keys;
    if (keys.length > 0)
      relaxed.set(
        effect.step_id,
        [
          ...new Set([
            ...(relaxed.get(effect.step_id) ?? existingRelaxed.get(effect.step_id) ?? []),
            ...keys,
          ]),
        ].sort(),
      );
  }
  if (!isDeepStrictEqual(granted.caller_guards ?? null, next.caller_guards ?? null)) {
    const entry = {
      kind: "changed_boundary" as const,
      connector_id: null,
      target: "execution_guards",
      effect: "write" as const,
    };
    growth.set(JSON.stringify(entry), entry);
  }
  return { growth: [...growth.values()], relaxed };
}
