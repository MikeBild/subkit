import { SYSTEM_TENANT_ID } from "../audit/index.ts";
import { closeDb, getDb } from "../db/client.ts";
import { newTraceId, withContext } from "../logging/context.ts";

export const PREFLIGHT_FLAGS = [
  "--preflight",
  "--vault-check",
  "--vault-set",
  "--rewrap-master-key",
] as const;

export const PREFLIGHT_HELP: string =
  "\nBootstrap preflight — run these when the engine refuses to start\n\n" +
  "  --preflight\n" +
  "      Can this release run on this database, object store and settings?\n" +
  "      Answers before anything is migrated. Changes nothing, ever.\n\n" +
  "  --vault-check <name>\n" +
  "      Is this secret still readable with the current MASTER_KEY?\n" +
  "      Changes nothing. Use it to confirm what the refusal said.\n\n" +
  "  --vault-set <name> --value-file <path>\n" +
  "      Put a new value in, when the old one can no longer be read.\n" +
  "      Writes a new version of the secret. The value is read from the\n" +
  "      file only — never from the command line, never from the shell.\n" +
  "      Options:\n" +
  "        --bind <setting.path>,…  also point these settings at the new\n" +
  "                                 version (without this they keep the old)\n" +
  '        --purpose "<text>"       why you did it; goes in the audit log\n' +
  "        --if-unreadable          do nothing if the secret still reads,\n" +
  "                                 so the same line is safe on every deploy\n" +
  "        --pending                write the value, but do not use it yet:\n" +
  "                                 it waits in the Cockpit (Einstellungen →\n" +
  "                                 Vorbereitete Änderungen) until someone\n" +
  "                                 clicks Freigeben; --bind then says what\n" +
  "                                 that approval re-pins. Use it when the\n" +
  "                                 engine is running and a person should\n" +
  "                                 decide, not the deploy script\n\n" +
  "  --rewrap-master-key --from-file <path-to-previous-key>\n" +
  "        --all-producers-stopped --stop-evidence-file <path-to-review>\n" +
  "        [--maintenance]          use the separately granted database login\n" +
  "      Re-encrypt the settings-secret registry after all producers stop.\n" +
  "      Retained credentials, encrypted content and approval proofs outside\n" +
  "      that registry are unsupported and cause refusal. Preserve the\n" +
  "      original MASTER_KEY; expired heartbeats are not a stop proof.\n\n" +
  "  Exit codes, the same for all four:\n" +
  "      0  done, or nothing needed doing\n" +
  "      1  something failed; read the line it printed\n" +
  "      2  you typed it wrong; the usage is printed with the error\n" +
  "      3  the answer is no — refused, or the secret is not readable\n";

export function isPreflightInvocation(argv: string[]): boolean {
  return PREFLIGHT_FLAGS.some((flag) => argv.includes(flag));
}

export async function runPreflightCliOrExit(
  argv: string[],
  loadConfigAndReconfigureLogger: () => Promise<unknown>,
): Promise<never> {
  const { parseVaultCliArgs, runVaultCli, VAULT_CLI_USAGE } = await import("./vault-cli.ts");
  const parsed = parseVaultCliArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`engine: ${parsed.message}\n\nUsage:\n${VAULT_CLI_USAGE}\n`);
    process.exit(2);
  }
  if (parsed.command.mode === "preflight") {
    const { checkMasterKey } = await import("./checks.ts");
    const { refusalLine, PREFLIGHT_EXIT_REFUSED } = await import("./contracts.ts");
    const result = checkMasterKey(process.env.MASTER_KEY);
    if (!result.ok) {
      process.stdout.write(`${refusalLine(result)}\n`);
      process.exit(PREFLIGHT_EXIT_REFUSED);
    }
  }

  await withContext(
    {
      trace_id: newTraceId(),
      tenant_id: SYSTEM_TENANT_ID,
      request_source: "cli",
      actor_id: "preflight",
    },
    async () => {
      let exitCode = 1;
      try {
        const { getConfig } = await import("../config/loader.ts");
        await loadConfigAndReconfigureLogger();
        const { createVaultOps } = await import("./vault-ops.ts");
        const { preflightOutcome } = await import("./runner.ts");
        const db = getDb();
        const cfg = getConfig();
        const ops = createVaultOps(db, () => preflightOutcome(db, cfg));
        const outcome = await runVaultCli(parsed.command, { ops });
        process.stdout.write(`${outcome.lines.join("\n")}\n`);
        exitCode = outcome.exitCode;
      } catch (err) {
        process.stderr.write(`engine: ${err instanceof Error ? err.message : String(err)}\n`);
        exitCode = 1;
      } finally {
        await closeDb().catch(() => {});
      }
      process.exit(exitCode);
    },
  );
  process.exit(1);
}
