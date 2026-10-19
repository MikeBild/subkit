import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const script of ["entrypoint.sh", "subkit-wrap.sh"]) {
  describe(script, () => {
    function databaseUrl(environment: Record<string, string>, secretFile = false): string {
      const root = mkdtempSync(join(tmpdir(), "subkit-container-environment-"));
      try {
        const env: Record<string, string> = {
          PATH: "/usr/bin:/bin",
          HOME: root,
          CONFIGURATION_DIRECTORY: root,
          STATE_DIRECTORY: root,
          MASTER_KEY: "a".repeat(64),
          ...environment,
        };
        if (secretFile) {
          const file = join(root, "database-uri");
          writeFileSync(file, environment.DATABASE_URL ?? "", { mode: 0o600 });
          delete env.DATABASE_URL;
          env.DATABASE_URL_FILE = file;
        }
        const result = Bun.spawnSync(
          [
            "/bin/bash",
            "-c",
            'exec() { printf "%s" "$DATABASE_URL"; }; source "$0"',
            join(import.meta.dir, script),
          ],
          { env, stdout: "pipe", stderr: "pipe", timeout: 5_000 },
        );
        expect(result.exitCode).toBe(0);
        return result.stdout.toString();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    test("preserves required TLS from a managed binding without introducing compatibility mode", () => {
      const uri = "postgresql://fixture:synthetic@database.example.test/app?sslmode=require";
      expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
      expect(databaseUrl({ DATABASE_URL: uri, UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
    });

    test("preserves explicit hostname verification and custom trust settings", () => {
      const uri =
        "postgresql://fixture:synthetic@database.example.test/app?sslmode=verify-full&sslrootcert=%2Frun%2Ftrust%2Fca.pem";
      expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
      expect(databaseUrl({ DATABASE_URL: uri }, true)).toBe(uri);
    });

    test("does not replace an explicit database URI with the managed fallback", () => {
      const uri = "postgresql://fixture:synthetic@selected.example.test/app?sslmode=verify-full";
      const fallback = "postgresql://fixture:synthetic@other.example.test/app?sslmode=require";
      expect(databaseUrl({ DATABASE_URL: uri, UPRAFT_DB_PRIMARY_URL: fallback })).toBe(uri);
    });

    test("leaves explicitly supplied compatibility policy unchanged", () => {
      const uri =
        "postgresql://fixture:synthetic@database.example.test/app?sslmode=require&uselibpqcompat=true";
      expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
    });
  });
}
