// The process entry point for the bootstrap-preflight operator commands.
//
// It lives here rather than in `index.ts` for two reasons: the engine
// entrypoint is at its LOC ceiling and every subsystem that grew a flag
// there paid for it, and the wiring below — parse, load config, open one
// short-lived db handle, print, close, exit — is this subsystem's shape, not
// the entrypoint's. `index.ts` keeps the dispatch decision and nothing else.

import { SYSTEM_TENANT_ID } from "../audit/index.ts";
import { closeDb, getDb } from "../db/client.ts";
import { newTraceId, withContext } from "../logging/context.ts";

/** The flags that route here. `index.ts` tests membership and nothing more. */
export const PREFLIGHT_FLAGS = [
  "--preflight",
  "--vault-check",
  "--vault-set",
  "--rewrap-master-key",
] as const;

/**
 * The help block `engine --help` appends for these commands.
 *
 * Written as a short runbook, not a flag list: each entry says WHEN you
 * reach for it, in plain words, and then what it changes. Someone reading
 * this is usually mid-incident — an engine that refused to start — and the
 * question they have is "which of these four do I run", which a list of
 * argument shapes does not answer. Exit codes are stated once, at the end,
 * because they are the same for all four.
 */
export const PREFLIGHT_HELP: string =
  "\nBootstrap preflight — run these when the engine refuses to start\n" +
  "(the full story: docs/admins/bootstrap-preflight.md)\n\n" +
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
  "      You changed MASTER_KEY and still have the old one: re-encrypt every\n" +
  "      stored secret under the new key. Stop all engines first — it refuses\n" +
  "      while any is running. Covers settings secrets, not connector\n" +
  "      credentials; those still have to be entered again.\n\n" +
  "  Exit codes, the same for all four:\n" +
  "      0  done, or nothing needed doing\n" +
  "      1  something failed; read the line it printed\n" +
  "      2  you typed it wrong; the usage is printed with the error\n" +
  "      3  the answer is no — refused, or the secret is not readable\n";

export function isPreflightInvocation(argv: string[]): boolean {
  return PREFLIGHT_FLAGS.some((flag) => argv.includes(flag));
}

/**
 * Run one operator command and exit. Never returns.
 *
 * The config is loaded (for `DATABASE_URL`), but nothing else about a boot
 * happens: no migration, no settings revision, no listener. A usage error
 * prints the message plus the usage block on stderr and exits 2, the way
 * `--rollback --to=` does.
 */
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
  // Check 1 runs BEFORE the config loader, because it is the one check that
  // needs nothing: no file, no database, no network. An operator whose
  // settings file is broken AND whose MASTER_KEY is wrong should be told
  // about the key, not handed a schema error that sends them to the wrong
  // file. Without this, `--preflight` on a bad key exits 1 with a config
  // message instead of 3 with the refusal it was asked for.
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
        // Plain stdout, one line per fact: a deploy script reads these, and
        // the secret value is never among them.
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
