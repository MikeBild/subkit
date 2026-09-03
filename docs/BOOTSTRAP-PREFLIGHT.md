# Bootstrap Preflight

Version 1.0 — this text is byte-identical in every product of the family. No product
shares code with another; each implements this contract on its own and proves it with
its own tests. A product must also pass this contract when no sibling product exists.

## What the preflight is

The preflight is the first thing the process does in production, before any schema
migration, before any settings revision is written, before any listener opens. It reads
the bootstrap it was given and decides whether this release can run on it. If it cannot,
the process exits non-zero with one structured error line and has changed nothing: no
migration applied, no revision written, no secret touched. A rollback to the previous
release is therefore always possible.

## What it checks, in this order

1. `MASTER_KEY` is present in production and is exactly 64 hexadecimal characters.
2. `DATABASE_URL` reaches PostgreSQL and the schema version is one this release can
   start from or migrate forward from. A schema that is newer than this release is
   refused with `schema_ahead`.
3. If the release stores objects, the object store it will use answers: the configured
   endpoint is a URL, the bucket exists or can be created, and a probe object can be
   written and read. A release that needs an object store and has none is refused with
   `object_store_missing` before it migrates anything.
4. The current settings revision, if one exists, parses under this release's schema
   after retired keys are dropped. Keys the release no longer manages are logged as
   `settings.retired_keys_dropped` and ignored; they are never a reason to refuse.
5. Every Vault or secret version the current settings bind to decrypts under the
   running `MASTER_KEY`. An unreadable version is reported as
   `secret_unreadable` with its name and version and is a refusal in production,
   because the release would otherwise start with bindings it cannot use.
6. The identity provider configuration is well-formed: issuer URL is https, the product
   will exchange authorization codes with PKCE and no client secret, and it says so in
   the log line `identity.client_type public`.

## What it never does

- It never rotates, generates or rewrites a secret.
- It never derives one secret from another. The API-key pepper is a secret of its own,
  stored encrypted like any other; rotating `MASTER_KEY` re-wraps secrets, it does not
  invalidate keys.
- It never depends on a sibling product being reachable.

## Operator commands every product offers

    <binary> --preflight                 run the checks and exit; 0 ok, 3 refused, 1 error
    <binary> --vault-check <name>        0 readable, 3 unreadable or absent, 1 error
    <binary> --vault-set <name> --value-file <path> [--bind <b>,…] [--purpose "…"] [--if-unreadable]
    <binary> --rewrap-master-key --from-file <path-to-previous-key>

`--vault-set` reads the value from a file only, never from an argument or the
environment, and prints no secret material. `--rewrap-master-key` re-encrypts every
secret version under the running `MASTER_KEY` using the previous key from the file and
refuses to run while the process is serving.

## Why

Measured on 2026-09-03 across the family: a release migrated its schema and wrote an
empty settings revision before discovering that its object store was not configured,
which made the rollback impossible; a release refused to boot on a settings key an
older release had persisted; two releases derived the API-key pepper from
`MASTER_KEY`, so introducing the key invalidated every API key; and secret versions
written under an earlier key were unreadable with no way to repair them but a person
at a form.
