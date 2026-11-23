import { emitList } from "@cli-core/format";
import { defineCommand } from "citty";
import type { CredentialBody } from "../engine-client/connectors.ts";
import type { VaultItem } from "../engine-client/vault.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";
import {
  defaultCredentialMode,
  parseVaultEnvironment,
  productionGap,
  resolveVaultTarget,
  targetLabel,
} from "./vault-target.ts";

const connectorCredentialsCommand = defineCommand({
  meta: { name: "connector", description: "List the vault items of one connector" },
  args: {
    "connector-id": { type: "positional", required: true, description: "Connector id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const connector = await client.getConnector(args["connector-id"]);
        const credentials = connector.credentials ?? [];
        emitList(
          !!args.json,
          ["id", "mode", "environment", "has_oauth_refresh", "created_at"],
          credentials,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

export interface CredentialArgs {
  mode: string;
  value?: string | undefined;
  header?: string | undefined;
  query?: string | undefined;
  username?: string | undefined;
  accessKeyId?: string | undefined;
}

export function namedValues(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return out;
}

function named(name: string | undefined, value: string): Record<string, string> {
  if (name) return { [name]: value };
  const pairs = namedValues(value);
  if (Object.keys(pairs).length === 0) throw new Error("write one Name=Value line per entry");
  return pairs;
}

function required(value: string | undefined, mode: string): string {
  if (!value) throw new Error(`${mode} mode reads its secret from stdin or a hidden prompt`);
  return value;
}

export function credentialBody(args: CredentialArgs): CredentialBody {
  const { mode } = args;
  if (mode === "none") return { mode };
  if (mode === "bearer") return { mode, token: required(args.value, mode) };
  if (mode === "signed_jwt") return { mode, private_key: required(args.value, mode) };
  if (mode === "header") return { mode, headers: named(args.header, required(args.value, mode)) };
  if (mode === "query") return { mode, query: named(args.query, required(args.value, mode)) };
  if (mode === "basic") {
    if (!args.username) throw new Error("basic mode requires --username");
    return { mode, username: args.username, password: required(args.value, mode) };
  }
  if (mode === "aws_sigv4") {
    if (!args.accessKeyId) throw new Error("aws_sigv4 mode requires --access-key-id");
    const [secret, session] = required(args.value, mode).split(/\r?\n/);
    return {
      mode,
      access_key_id: args.accessKeyId,
      secret_access_key: required(secret, mode),
      ...(session ? { session_token: session } : {}),
    };
  }
  throw new Error(`unknown --mode '${mode}' (bearer|header|query|basic|aws_sigv4|signed_jwt|none)`);
}

const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description:
      "Attach a connector's credential as a vault item. Name the connector by slug or id and choose its record with --env; each environment keeps its own credential. The secret comes from stdin or a hidden prompt, never from arguments: the token, the header or query value, the password, the PEM key, or for aws_sigv4 the secret access key and an optional session token on a second line.",
  },
  args: {
    "connector-id": {
      type: "positional",
      required: true,
      description: "Connector slug or id",
    },
    env: {
      type: "string",
      description: "dev | prod: the connector record to attach to; required when the slug has both",
    },
    mode: {
      type: "string",
      description:
        "bearer | header | query | basic | aws_sigv4 | signed_jwt | none (default: the connector's auth type)",
    },
    header: {
      type: "string",
      description: "header mode: the header name; without it stdin holds Name=Value lines",
    },
    query: {
      type: "string",
      description: "query mode: the parameter name; without it stdin holds name=value lines",
    },
    username: { type: "string", description: "basic mode username" },
    "access-key-id": { type: "string", description: "aws_sigv4 access key id" },
    "skip-checks": { type: "boolean", description: "Skip the post-set connectivity probe" },
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    return withCommandErrors(
      async () => {
        const target = await resolveVaultTarget(
          client,
          String(args["connector-id"]),
          parseVaultEnvironment(args.env),
        );
        const mode = args.mode
          ? String(args.mode).replace(/-/g, "_")
          : defaultCredentialMode(target);
        const body = credentialBody({
          mode,
          value: mode === "none" ? undefined : await readSecretValue(),
          header: args.header,
          query: args.query,
          username: args.username,
          accessKeyId: args["access-key-id"],
        });

        const created = await client.createCredential(target.id, body);
        let probe: { ok: boolean; error?: string } | undefined;
        if (!args["skip-checks"]) {
          try {
            const result = await client.testConnector(target.id);
            probe = { ok: result.ok === true };
          } catch {
            probe = { ok: false, error: "probe_failed" };
          }
        }
        const warning = await productionGap(client, target).catch(() => null);
        if (jsonMode) {
          process.stdout.write(
            `${JSON.stringify({
              ...created,
              connector: {
                id: target.id,
                slug: target.slug,
                name: target.display_name,
                environment: target.environment,
              },
              ...(probe ? { probe } : {}),
              ...(warning ? { warning } : {}),
            })}\n`,
          );
        } else {
          process.stdout.write(`✓ credential attached to ${targetLabel(target)}\n`);
          if (probe) process.stdout.write(probe.ok ? "✓ probe ok\n" : "⚠ probe did not succeed\n");
        }
        if (warning) process.stderr.write(`⚠ ${warning}\n`);
        if (probe && !probe.ok) process.exitCode = 1;
      },
      { json: jsonMode },
    );
  },
});

export async function readSecretValue(
  stdin: NodeJS.ReadStream = process.stdin,
  prompt: (label: string) => string | null = (label) => globalThis.prompt?.(label) ?? null,
): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    const value = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    if (!value) throw new Error("the value is empty; pipe it on stdin, never as an argument");
    return value;
  }
  const value = prompt("Value (not shown in history):");
  if (!value) throw new Error("the value is empty");
  return value;
}

export function vaultRows(items: readonly VaultItem[]) {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    scope: item.scope,
    environment: item.environment,
    version: item.version,
    connector: item.connector?.slug ?? "",
    last_used_at: item.last_used_at ?? "",
  }));
}

const VAULT_COLUMNS = [
  "id",
  "name",
  "kind",
  "scope",
  "environment",
  "version",
  "connector",
  "last_used_at",
];

const listCommand = defineCommand({
  meta: { name: "list", description: "List vault items: names and metadata, never values" },
  args: {
    scope: { type: "string", description: "workspace | person" },
    kind: { type: "string", description: "connector | secret | login | template_client" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const items = await client.listVaultItems({
          ...(args.scope ? { scope: args.scope as "workspace" | "person" } : {}),
          ...(args.kind ? { kind: args.kind as VaultItem["kind"] } : {}),
        });
        emitList(!!args.json, VAULT_COLUMNS, vaultRows(items));
      },
      { json: Boolean(args.json) },
    );
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "Show one vault item's metadata and activity" },
  args: {
    id: { type: "positional", required: true, description: "Vault item id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const [item, activity] = await Promise.all([
          client.getVaultItem(String(args.id)),
          client.vaultItemActivity(String(args.id)),
        ]);
        if (args.json) {
          process.stdout.write(`${JSON.stringify({ ...item, activity: activity.items })}\n`);
          return;
        }
        const handle = `\${secret.${item.scope === "person" ? "me." : ""}${item.name}}`;
        process.stdout.write(
          `${item.name}  ${item.kind}  ${item.scope}  ${item.environment}  v${item.version}\n`,
        );
        if (item.kind === "secret" || item.kind === "login") {
          process.stdout.write(`handle: ${handle}\n`);
        }
        for (const entry of activity.items) {
          process.stdout.write(`${entry.at}  ${entry.action}\n`);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const addCommand = defineCommand({
  meta: {
    name: "add",
    description:
      "Add a secret or a login. The token or password is read from stdin or a hidden prompt, never from arguments.",
  },
  args: {
    name: { type: "positional", required: true, description: "Handle name, e.g. crm-token" },
    kind: { type: "string", default: "secret", description: "secret | login" },
    username: { type: "string", description: "login: the username" },
    scope: { type: "string", default: "workspace", description: "workspace | person" },
    env: { type: "string", default: "prod", description: "dev | prod" },
    description: { type: "string", description: "What the item is for" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const kind = String(args.kind);
        if (kind !== "secret" && kind !== "login") throw new Error("--kind is secret or login");
        if (kind === "login" && !args.username) throw new Error("a login needs --username");
        const value = await readSecretValue();
        const item = await client.createVaultItem({
          kind,
          name: String(args.name),
          scope: String(args.scope) as "workspace" | "person",
          environment: String(args.env) as "dev" | "prod",
          ...(args.description ? { description: String(args.description) } : {}),
          ...(kind === "secret"
            ? { token: value }
            : { username: String(args.username), password: value }),
        });
        if (args.json) process.stdout.write(`${JSON.stringify(item)}\n`);
        else process.stdout.write(`✓ ${item.name} saved (version ${item.version})\n`);
      },
      { json: Boolean(args.json) },
    );
  },
});

const rotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description: "Replace the value of a secret or login. The new value is read from stdin.",
  },
  args: {
    id: { type: "positional", required: true, description: "Vault item id" },
    username: { type: "string", description: "login: a new username" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const item = await client.getVaultItem(String(args.id));
      const value = await readSecretValue();
      const updated = await client.updateVaultItem(
        item.id,
        item.kind === "login"
          ? { ...(args.username ? { username: String(args.username) } : {}), password: value }
          : { token: value },
      );
      process.stdout.write(`✓ ${updated.name} rotated to version ${updated.version}\n`);
    });
  },
});

const revealCommand = defineCommand({
  meta: {
    name: "reveal",
    description: "Print a vault item's value. Every reveal is recorded in the audit log.",
  },
  args: {
    id: { type: "positional", required: true, description: "Vault item id" },
    field: { type: "string", description: "Print only this field" },
    yes: { type: "boolean", description: "Confirm that the value may appear in this terminal" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      if (!args.yes)
        throw new Error("add --yes to print the value; it is recorded in the audit log");
      const revealed = await client.revealVaultItem(String(args.id));
      if (args.field) {
        const value = revealed.values[String(args.field)];
        if (value === undefined) throw new Error(`no field ${args.field}`);
        process.stdout.write(`${value}\n`);
        return;
      }
      for (const [field, value] of Object.entries(revealed.values)) {
        process.stdout.write(`${field}: ${value}\n`);
      }
    });
  },
});

const refreshCommand = defineCommand({
  meta: { name: "refresh", description: "Refresh the OAuth token of a connector's vault item" },
  args: {
    id: { type: "positional", required: true, description: "Vault item id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.refreshVaultItem(String(args.id));
      process.stdout.write("refreshed\n");
    });
  },
});

const removeCommand = defineCommand({
  meta: { name: "rm", description: "Delete a vault item and its value" },
  args: {
    id: { type: "positional", required: true, description: "Vault item id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteVaultItem(String(args.id));
      process.stdout.write("deleted\n");
    });
  },
});

export const vaultCommand = defineCommand({
  meta: {
    name: "vault",
    description:
      "The vault (Tresor): secrets, logins and connector credentials. Workflows name an item as \u0024{secret.<name>}; values never reach the model.",
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    add: addCommand,
    rotate: rotateCommand,
    reveal: revealCommand,
    refresh: refreshCommand,
    rm: removeCommand,
    attach: attachCommand,
    connector: connectorCredentialsCommand,
  },
});
