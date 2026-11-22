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
        expect(result.stderr.toString()).not.toContain("fixture:synthetic");
        return result.stdout.toString();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    test("preserves the required TLS contract of an exact managed binding", () => {
      const uri = "postgresql://fixture:synthetic@database.example.test/app?sslmode=require";
      expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(`${uri}&uselibpqcompat=true`);
      expect(databaseUrl({ DATABASE_URL: uri, UPRAFT_DB_PRIMARY_URL: uri })).toBe(
        `${uri}&uselibpqcompat=true`,
      );
      expect(databaseUrl({ DATABASE_URL: uri, UPRAFT_DB_PRIMARY_URL: uri }, true)).toBe(
        `${uri}&uselibpqcompat=true`,
      );
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

    test("preserves standalone required TLS and explicit managed trust policy", () => {
      const base = "postgresql://fixture:synthetic@database.example.test/app?sslmode=require";
      expect(databaseUrl({ DATABASE_URL: base })).toBe(base);
      for (const suffix of [
        "&sslrootcert=%2Frun%2Fca.pem",
        "&sslrootcert=/run/ca.pem",
        "&sslcert=/run/client.pem",
        "&sslkey=/run/client.key",
        "&ssl=true",
        "&uselibpqcompat=false",
      ]) {
        const uri = `${base}${suffix}`;
        expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
      }
    });

    test("preserves explicit operator trust environment including empty values", () => {
      const uri = "postgresql://fixture:synthetic@database.example.test/app?sslmode=require";
      for (const name of [
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "PGSSLROOTCERT",
        "PGSSLMODE",
      ]) {
        for (const value of ["", name === "PGSSLMODE" ? "verify-full" : "/run/trust/ca.pem"]) {
          expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri, [name]: value })).toBe(uri);
        }
      }
    });

    test("does not reinterpret ambiguous or malformed managed TLS parameters", () => {
      const base = "postgresql://fixture:synthetic@database.example.test/app?";
      for (const query of [
        "sslmode=require&sslmode=verify-full",
        "sslmode=verify-full&sslmode=require",
        "sslmode=require&sslmode=require",
        "sslmode=require&SSLMODE=verify-full",
        "sslmode=require&%73slrootcert=/run/ca.pem",
        "sslmode=%72equire",
        "sslmode=require&application_name=invalid%",
        "sslmode=require&application_name=invalid%2",
        "sslmode=require&application_name=invalid%GG",
        "sslmode=require&options=invalid%0G",
        "sslmode=require&%6fptions=encoded-key",
        "sslmode=require&connect_timeout=%31%30",
        "sslmode=require&application_name=a&application_name=b",
        "sslmode=require&unknown=value",
        "sslmode=require&",
        "&sslmode=require",
        "sslmode=require&&application_name=fixture",
        "sslmode=require#fragment",
        "sslmode=require;sslmode=verify-full",
        "sslmode=require?sslmode=verify-full",
        "sslmode=require\nsslmode=verify-full",
        "sslmode=requirement",
        "sslmode=verify-full",
        "sslmode=disable",
        "sslmode=verify-ca",
        "other_sslmode=require",
      ]) {
        const uri = `${base}${query}`;
        expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
      }
      for (const uri of [
        "postgresql://fixture:synthetic@database.example.test/app#fragment?sslmode=require",
        "postgresql://fixture:synthetic@database.example.test/app\n?sslmode=require",
      ]) {
        expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
      }
    });

    test("recognizes canonical required TLS with unique ordinary connection parameters", () => {
      const uri =
        "postgres://fixture:synthetic@database.example.test/app?application_name=fixture&sslmode=require&connect_timeout=10";
      expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(`${uri}&uselibpqcompat=true`);
    });

    test("preserves valid encoded ordinary parameter values while applying managed require", () => {
      for (const parameters of [
        "application_name=SubKit%20Cloud",
        "options=-c%20search_path%3Dsubkit%2Cpublic",
        "application_name=literal%26sslmode%3Dverify-full%23fragment",
        "application_name=literal%253B%2f%2F&options=-c%20name%3Dvalue",
      ]) {
        const uri = `postgresql://fixture:synthetic@database.example.test/app?sslmode=require&${parameters}`;
        expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(`${uri}&uselibpqcompat=true`);
      }
    });

    test("leaves explicitly supplied compatibility policy unchanged", () => {
      const uri =
        "postgresql://fixture:synthetic@database.example.test/app?sslmode=require&uselibpqcompat=true";
      expect(databaseUrl({ UPRAFT_DB_PRIMARY_URL: uri })).toBe(uri);
    });
  });
}
