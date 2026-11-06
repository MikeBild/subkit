import { syntheticVaultStopAcknowledgement } from "../../test-helpers/vault-maintenance.ts";
import { parseVaultCliArgs, type VaultCliCommand, type VaultOps } from "../vault-cli.ts";

export const VALUE = "s3cr3t-value-nobody-should-see";

export const VALUE_FILE = "/run/secrets/new";

export const KEY_FILE = "/run/secrets/previous-master-key";

export const PREVIOUS_KEY = "b".repeat(64);

export const STOP_EVIDENCE_FILE = "/run/review/producer-stop";

interface FakeState {
  version: number | null;
  readable: boolean;
  absent: boolean;
  created: Array<{ name: string; value: string; purpose: string | null }>;
  prepared: Array<{ name: string; value: string; purpose: string | null; bindings: string[] }>;
  rebound: string[];
  serving: string[];
  rewrapped: string[];
}

export function stateWith(partial: Partial<FakeState> = {}): FakeState {
  return {
    version: 1,
    readable: true,
    absent: false,
    created: [],
    prepared: [],
    rebound: [],
    serving: [],
    rewrapped: [],
    ...partial,
  };
}

const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is not used by this command`);
};

export function opsFor(state: FakeState, overrides: Partial<VaultOps> = {}): VaultOps {
  return {
    probeCurrentVersion: async () => ({
      version: state.version,
      readable: state.readable,
      absent: state.absent,
    }),
    createVersion: async (name, value, purpose) => {
      state.created.push({ name, value, purpose });
      const next = (state.version ?? 0) + 1;
      state.version = next;
      state.absent = false;
      state.readable = true;
      return { version: next };
    },
    prepareVersion: async (name, value, purpose, bindings) => {
      state.prepared.push({ name, value, purpose, bindings });
      return { version: (state.version ?? 0) + 1 };
    },
    rebind: async (path, name, version) => {
      state.rebound.push(path);
      return { path, name, version };
    },
    servingReplicas: async () => state.serving,
    rewrap: async (previousKeyHex) => {
      state.rewrapped.push(previousKeyHex);
      return { names: 2, versions: 5 };
    },
    preflight: unavailable("preflight") as unknown as VaultOps["preflight"],
    ...overrides,
  };
}

export function command(argv: string[]): VaultCliCommand {
  const parsed = parseVaultCliArgs(argv);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.message}`);
  return parsed.command;
}

export function readValueFile(path: string): string {
  if (path === VALUE_FILE) return `${VALUE}\n`;
  if (path === KEY_FILE) return `${PREVIOUS_KEY}\n`;
  if (path === STOP_EVIDENCE_FILE) return syntheticVaultStopAcknowledgement.evidence;
  throw new Error(`unexpected path: ${path}`);
}
