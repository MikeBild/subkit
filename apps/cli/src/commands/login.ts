// `subkit login` — store engine credentials in ~/.subkit/config.json.
//
// Three paths:
//
//   1. `--api-key <key>` — scripted bootstrap. Writes the key as-is.
//
//   2. Browser-based login (Firebase or similar). Queries the engine's
//      GET /v1/identity/providers to discover available auth methods,
//      then opens a browser to the provider's login page.
//
//   3. OIDC device flow (fallback when the provider supports it).

import * as prompts from "@clack/prompts";
import {
  type DeviceFlowOptions,
  type DeviceFlowResult,
  runBrowserLogin,
  runDeviceFlow,
} from "@cli-core/index.ts";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configPath, DEFAULT_ENGINE_URL, loadConfig, saveProfile } from "../config.ts";

export type { DeviceFlowOptions, DeviceFlowResult };
export { runDeviceFlow };

const DEFAULT_SCOPE = "openid profile email offline_access";

interface AuthProvider {
  type: string;
  name: string;
  login_url?: string;
  issuer?: string;
}

async function discoverProviders(engineUrl: string): Promise<AuthProvider[]> {
  try {
    const res = await fetch(`${engineUrl}/v1/identity/providers`);
    if (!res.ok) return [{ type: "api-key", name: "API key" }];
    const data = (await res.json()) as { providers: AuthProvider[] };
    return data.providers;
  } catch {
    return [{ type: "api-key", name: "API key" }];
  }
}

function pickFlag(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export const loginCommand = defineCommand({
  meta: { name: "login", description: "Authenticate against the engine" },
  args: {
    "engine-url": { type: "string", description: "Engine base URL" },
    "api-key": { type: "string", description: "API key (Bearer); skips interactive login" },
    tenant: { type: "string", description: "Default tenant id" },
    profile: { type: "string", description: 'Profile name (default: "default")' },
    "issuer-url": { type: "string", description: "OIDC issuer URL (device flow)" },
    "client-id": { type: "string", description: "OIDC client id (device flow)" },
    scope: { type: "string", description: "OIDC scope override" },
  },
  async run({ args }) {
    const profileName = pickFlag(args as Record<string, unknown>, "profile") ?? "default";
    const cfg = loadConfig();
    const existingProfile = cfg.profiles[profileName] ?? {
      engine_url: DEFAULT_ENGINE_URL,
      api_key: "",
      active_tenant_id: null,
    };
    const engine_url =
      pickFlag(args as Record<string, unknown>, "engine-url") ||
      existingProfile.engine_url ||
      DEFAULT_ENGINE_URL;

    // Path 1: --api-key shortcut. Bypasses interactive login.
    const explicitKey = pickFlag(args as Record<string, unknown>, "api-key");
    if (explicitKey) {
      saveProfile({
        name: profileName,
        engine_url,
        api_key: explicitKey,
        active_tenant_id:
          pickFlag(args as Record<string, unknown>, "tenant") ??
          existingProfile.active_tenant_id ??
          null,
      });
      process.stdout.write(
        `${pc.green("ok")} profile "${profileName}" saved to ${pc.bold(configPath())}\n  engine_url=${engine_url}\n`,
      );
      return;
    }

    // Discover available auth providers from the engine
    const providers = await discoverProviders(engine_url);
    const interactiveProviders = providers.filter((p) => p.type !== "api-key");

    // If we have browser-based providers, let the user pick
    if (interactiveProviders.length > 0) {
      let selectedProvider: AuthProvider;

      if (interactiveProviders.length === 1) {
        selectedProvider = interactiveProviders[0]!;
      } else {
        const selected = await prompts.select({
          message: "Sign in with",
          options: interactiveProviders.map((p) => ({
            value: p.type,
            label: p.name,
            hint: p.login_url ?? p.issuer ?? "",
          })),
        });
        if (prompts.isCancel(selected)) return;
        selectedProvider = interactiveProviders.find((p) => p.type === selected)!;
      }

      // Firebase / browser-based provider
      if (selectedProvider.type === "firebase" && selectedProvider.login_url) {
        process.stdout.write(`${pc.cyan("signing in")} via ${selectedProvider.name}...\n`);
        try {
          const result = await runBrowserLogin({
            login_url: selectedProvider.login_url,
            engine_url,
          });
          saveProfile({
            name: profileName,
            engine_url,
            api_key: result.api_key,
            active_tenant_id: result.tenant_id,
          });
          process.stdout.write(
            `${pc.green("ok")} signed in as ${pc.bold(result.email || result.sub)} — profile "${profileName}" saved\n`,
          );
          return;
        } catch (err) {
          process.stderr.write(
            `${pc.red("login failed")}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      }

      // OIDC device flow provider
      if (selectedProvider.type === "oidc" && selectedProvider.issuer) {
        const clientId =
          pickFlag(args as Record<string, unknown>, "client-id") ||
          process.env.SUBKIT_OIDC_CLIENT_ID ||
          "";
        const scope = pickFlag(args as Record<string, unknown>, "scope") || DEFAULT_SCOPE;

        let resolvedClientId = clientId;
        if (!resolvedClientId) {
          const v = await prompts.text({
            message: "OIDC client id",
            placeholder: "subkit-cli",
          });
          if (prompts.isCancel(v)) return;
          resolvedClientId = v as string;
        }

        try {
          const result = await runDeviceFlow({
            issuer_url: selectedProvider.issuer,
            client_id: resolvedClientId,
            engine_url,
            scope,
          });
          saveProfile({
            name: profileName,
            engine_url,
            api_key: result.api_key,
            active_tenant_id: result.tenant_id ?? null,
          });
          process.stdout.write(
            `${pc.green("ok")} signed in as ${pc.bold(result.sub)} — profile "${profileName}" saved\n`,
          );
          return;
        } catch (err) {
          process.stderr.write(
            `${pc.red("login failed")}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      }
    }

    // Fallback: manual OIDC device flow (no providers discovered)
    let issuer_url =
      pickFlag(args as Record<string, unknown>, "issuer-url") ||
      process.env.SUBKIT_OIDC_ISSUER ||
      "";
    let client_id =
      pickFlag(args as Record<string, unknown>, "client-id") ||
      process.env.SUBKIT_OIDC_CLIENT_ID ||
      "";
    const scope = pickFlag(args as Record<string, unknown>, "scope") || DEFAULT_SCOPE;

    try {
      if (!issuer_url) {
        const v = await prompts.text({
          message: "OIDC issuer URL",
          placeholder: "https://login.example.com/realms/main",
        });
        if (prompts.isCancel(v)) {
          process.stdout.write(`${pc.yellow("login cancelled")}\n`);
          return;
        }
        issuer_url = v as string;
      }
      if (!client_id) {
        const v = await prompts.text({
          message: "OIDC client id",
          placeholder: "subkit-cli",
        });
        if (prompts.isCancel(v)) {
          process.stdout.write(`${pc.yellow("login cancelled")}\n`);
          return;
        }
        client_id = v as string;
      }
    } catch {
      process.stdout.write(`${pc.yellow("login cancelled")}\n`);
      return;
    }

    let result: DeviceFlowResult;
    try {
      result = await runDeviceFlow({ issuer_url, client_id, engine_url, scope });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${pc.red("login failed")}: ${msg}\n`);
      process.exit(1);
    }

    saveProfile({
      name: profileName,
      engine_url,
      api_key: result.api_key,
      active_tenant_id:
        pickFlag(args as Record<string, unknown>, "tenant") ?? result.tenant_id ?? null,
    });
    process.stdout.write(
      `${pc.green("ok")} signed in as ${pc.bold(result.sub)} — profile "${profileName}" saved to ${pc.bold(configPath())}\n`,
    );
  },
});
