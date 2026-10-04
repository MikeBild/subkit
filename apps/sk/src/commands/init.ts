import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import {
  configPath,
  DEFAULT_ENGINE_URL,
  DEFAULT_PROFILE,
  loadConfig,
  saveProfile,
} from "../config.ts";

const LLM_PROVIDERS = [
  "mock",
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];

interface SetupOk {
  tenant_id: string;
  user_id: string;
  api_key: string;
  api_key_prefix: string;
}

interface SetupErrorBody {
  code?: string;
  message?: string;
  hint?: string;
}

interface SetupPayload {
  token: string;
  admin_email: string;
  tenant_name: string;
  llm_provider: LlmProvider;
  llm_api_key: string;
}

export interface RunInitOptions {
  payload: SetupPayload;
  engine_url: string;
  profile: string;
  fetchImpl?: typeof fetch;
  saveProfileImpl?: typeof saveProfile;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface RunInitResult {
  status: "ok" | "failed";
  exitCode: number;
  setup?: SetupOk;
  error?: { code: string; message: string; httpStatus: number };
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const save = opts.saveProfileImpl ?? saveProfile;
  const out = opts.out ?? ((line: string) => process.stdout.write(line));
  const err = opts.err ?? ((line: string) => process.stderr.write(line));

  const url = `${opts.engine_url.replace(/\/$/, "")}/v1/setup`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.payload),
    });
  } catch (e) {
    err(
      `sk init: engine unreachable at ${opts.engine_url}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {
      status: "failed",
      exitCode: 2,
      error: { code: "engine_unreachable", message: "engine unreachable", httpStatus: 0 },
    };
  }

  if (res.status === 200) {
    const body = (await res.json()) as SetupOk;
    save({
      name: opts.profile,
      engine_url: opts.engine_url,
      api_key: body.api_key,
      active_tenant_id: body.tenant_id,
    });
    out(
      `sk init: bootstrap complete — tenant ${body.tenant_id}\n` +
        `  admin_api_key prefix: ${body.api_key_prefix}\n` +
        `  profile '${opts.profile}' saved to ${configPath()}\n` +
        `  starter workflows are ready; run one now:\n` +
        `    sk workflows run demo-httpbin-echo --follow\n` +
        `  then: sk doctor\n`,
    );
    return { status: "ok", exitCode: 0, setup: body };
  }

  let parsed: SetupErrorBody = {};
  try {
    parsed = (await res.json()) as SetupErrorBody;
  } catch {}
  const code = parsed.code ?? `http_${res.status}`;
  const message = parsed.message ?? `setup failed with HTTP ${res.status}`;
  err(`sk init: ${message} (code=${code}, http=${res.status})\n`);
  if (parsed.hint) {
    err(`  hint: ${parsed.hint}\n`);
  } else if (code === "token_expired") {
    err(
      "  hint: the bootstrap token expires 15 minutes after engine boot — the engine reprints a fresh banner on an expired attempt; copy the new `sk init --token <token>` command from the engine logs and re-run it.\n",
    );
  }
  if (res.status === 410) {
    err("sk init: this engine has already been bootstrapped — run 'sk login' instead.\n");
  }
  return {
    status: "failed",
    exitCode: 2,
    error: { code, message, httpStatus: res.status },
  };
}

async function promptForMissing(
  partial: Partial<SetupPayload> & { token: string },
): Promise<SetupPayload | null> {
  const fields = await prompts.group(
    {
      admin_email: () =>
        partial.admin_email
          ? Promise.resolve(partial.admin_email)
          : prompts.text({
              message: "Admin email",
              placeholder: "ops@example.com",
              validate: (v) =>
                typeof v === "string" && /.+@.+\..+/.test(v) ? undefined : "Enter a valid email",
            }),
      tenant_name: () =>
        partial.tenant_name
          ? Promise.resolve(partial.tenant_name)
          : prompts.text({
              message: "Tenant name",
              placeholder: "Acme Corp",
              validate: (v) => (typeof v === "string" && v.length > 0 ? undefined : "Required"),
            }),
      llm_provider: () =>
        partial.llm_provider
          ? Promise.resolve(partial.llm_provider)
          : prompts.select({
              message: "LLM provider",
              options: LLM_PROVIDERS.map((p) => ({ value: p, label: p })),
              initialValue: "anthropic" as LlmProvider,
            }),
      llm_api_key: () =>
        partial.llm_api_key
          ? Promise.resolve(partial.llm_api_key)
          : prompts.password({
              message: "LLM API key",
              validate: (v) => (typeof v === "string" && v.length > 0 ? undefined : "Required"),
            }),
    },
    {
      onCancel: () => {
        prompts.cancel("sk init: cancelled");
        process.exit(0);
      },
    },
  );

  if (
    typeof fields.admin_email !== "string" ||
    typeof fields.tenant_name !== "string" ||
    typeof fields.llm_provider !== "string" ||
    typeof fields.llm_api_key !== "string"
  ) {
    return null;
  }

  return {
    token: partial.token,
    admin_email: fields.admin_email,
    tenant_name: fields.tenant_name,
    llm_provider: fields.llm_provider as LlmProvider,
    llm_api_key: fields.llm_api_key,
  };
}

export const LOCAL_DEFAULT_TENANT_NAME = "Local";
export const LOCAL_DEFAULT_LLM_PROVIDER = "mock" as const;
export const LOCAL_DEFAULT_LLM_API_KEY = "mock-local-no-external-account";
export const LOCAL_DEFAULT_ADMIN_EMAIL = "admin@example.com";

export function gitConfigEmail(): string | undefined {
  const res = spawnSync("git", ["config", "--get", "user.email"], { encoding: "utf8" });
  const value = res.status === 0 ? res.stdout.trim() : "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : undefined;
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Complete first-run engine bootstrap (consumes the token printed at engine boot)",
  },
  args: {
    token: {
      type: "string",
      description: "One-time bootstrap token printed by the engine on first boot",
      required: false,
    },
    "engine-url": {
      type: "string",
      description: "Engine base URL (defaults to http://localhost:3000)",
    },
    profile: {
      type: "string",
      description: `Profile to write the new admin key into (default: ${DEFAULT_PROFILE})`,
    },
    "admin-email": { type: "string", description: "Admin user email (skip prompt)" },
    "tenant-name": { type: "string", description: "Tenant display name (skip prompt)" },
    "llm-provider": {
      type: "string",
      description: `LLM provider: ${LLM_PROVIDERS.join("|")} (skip prompt)`,
    },
    "llm-api-key": { type: "string", description: "LLM API key (skip prompt)" },
    defaults: {
      type: "boolean",
      description:
        "Never prompt: fill anything still missing with local defaults (mock LLM provider, tenant 'Local', admin email from git config)",
    },
  },
  async run({ args }) {
    let token = args.token as string | undefined;
    if (!token) {
      const tokenFile = process.env.SUBKIT_BOOTSTRAP_TOKEN_FILE;
      if (tokenFile && existsSync(tokenFile)) {
        const fromFile = readFileSync(tokenFile, "utf8").trim();
        if (fromFile.length > 0) {
          token = fromFile;
          process.stderr.write(`sk init: using bootstrap token from ${tokenFile}\n`);
        }
      }
    }
    if (!token) {
      process.stderr.write(
        "sk init: --token <token> is required.\n" +
          "  The token was printed in the engine's startup banner on first boot.\n" +
          "  (On the all-in-one Docker image, `sk init` auto-detects it — no token needed.)\n",
      );
      process.exit(2);
    }

    const engineUrl =
      (args["engine-url"] as string | undefined) ??
      process.env.SUBKIT_ENGINE_URL ??
      DEFAULT_ENGINE_URL;
    const profileName =
      (args.profile as string | undefined) ?? loadConfig().active_profile ?? DEFAULT_PROFILE;

    const partial: Partial<SetupPayload> & { token: string } = { token };
    const adminEmail = args["admin-email"] as string | undefined;
    const tenantName = args["tenant-name"] as string | undefined;
    const llmProvider = args["llm-provider"] as string | undefined;
    const llmApiKey = args["llm-api-key"] as string | undefined;
    if (adminEmail) partial.admin_email = adminEmail;
    if (tenantName) partial.tenant_name = tenantName;
    if (llmProvider) {
      if (!(LLM_PROVIDERS as readonly string[]).includes(llmProvider)) {
        process.stderr.write(
          `sk init: --llm-provider must be one of ${LLM_PROVIDERS.join(", ")}\n`,
        );
        process.exit(2);
      }
      partial.llm_provider = llmProvider as LlmProvider;
    }
    if (llmApiKey) partial.llm_api_key = llmApiKey;

    if (args.defaults) {
      partial.admin_email ??= gitConfigEmail() ?? LOCAL_DEFAULT_ADMIN_EMAIL;
      partial.tenant_name ??= LOCAL_DEFAULT_TENANT_NAME;
      partial.llm_provider ??= LOCAL_DEFAULT_LLM_PROVIDER;
      partial.llm_api_key ??=
        partial.llm_provider === LOCAL_DEFAULT_LLM_PROVIDER ? LOCAL_DEFAULT_LLM_API_KEY : "";
      if (!partial.llm_api_key) {
        process.stderr.write(
          `sk init: --defaults needs --llm-api-key when --llm-provider is ${partial.llm_provider}; only 'mock' has a usable placeholder\n`,
        );
        process.exit(2);
      }
    }

    const fullyHeadless =
      partial.admin_email && partial.tenant_name && partial.llm_provider && partial.llm_api_key;

    const payload = fullyHeadless ? (partial as SetupPayload) : await promptForMissing(partial);
    if (!payload) {
      process.stdout.write("sk init: cancelled\n");
      return;
    }

    const result = await runInit({
      payload,
      engine_url: engineUrl,
      profile: profileName,
    });
    process.exit(result.exitCode);
  },
});
