# Releasing SubKit

A release is cut from `main` on your machine. `bun run release tag` runs the release gate, sets a
commit status and pushes the tag; the `release` workflow then builds, verifies and publishes the
image and the binaries. The desktop app follows with its own workflow, see
[apps/desktop/RELEASING.md](apps/desktop/RELEASING.md).

## The ritual

1. Start from a clean `main` that matches `origin/main`.
2. Update dependencies:

   ```sh
   bun run release deps
   ```

   It reports every outdated dependency of the root, `apps/cockpit` and `apps/desktop`, and applies
   the minor and patch updates that the version ranges allow. It holds exact pins, patched packages,
   overrides, local files and new majors and says why; update those by hand. `--check` only
   reports. Run `bun run verify static` and commit the updates on their own.
3. Bump the version in every package:

   ```sh
   bun run release bump <version>
   ```

   Commit the bump.
4. Produce the mutation evidence for this commit. It runs long and is only needed once per commit:

   ```sh
   bun run quality release
   ```

5. Push `main`, wait for the `quality` workflow of that commit, then tag:

   ```sh
   bun run release tag
   ```

   `release tag` refuses a dirty tree, a commit that differs from `origin/main` and a version that
   was used before. It then checks the mutation evidence (`bun run quality release --check`), runs
   the paid live model gate (`bun run verify llm-live`) and the release gate
   (`bun run verify release`), and only then pushes the tag.
   To release before the mutation evidence is ready, tag with `bun run release tag --defer-mutation`.
   It skips `bun run quality release --check`, runs `bun run verify release --defer-mutation` and prints a
   loud warning. The release gate status then ends in `mutation: deferred`, and the GitHub release notes
   say "Mutation evidence: deferred". Produce the evidence afterwards with `bun run quality release`.
   Without the flag nothing changes.
6. After the `release` workflow has published, check the deployed engine:

   ```sh
   bun run release verify --engine-url <url> --version <version>
   ```

## Gates

There is one gate list, in `scripts/lib/commands.ts`. Each profile is a subset of it:

| Command | Runs |
| --- | --- |
| `bun run verify push` | What the `pre-push` hook runs: lint, typecheck, invariants, generated files, determinism, the binaries |
| `bun run verify static` | Every static check and drift check, the desktop tests and the contract tests |
| `bun run verify` | `full`: the static gate plus the whole test suite, evals, e2e, coverage and mutation |
| `bun run verify release` | Mutation evidence, the static gate, coverage, docker tests and the smoke test |
| `bun run verify release --defer-mutation` | The release gate without the mutation evidence check, with a warning |

`bun run verify <check>` runs a single check, for example `bun run verify desktop`.
`bun run verify help` lists every check.

## Quality

| Command | Does |
| --- | --- |
| `bun run quality coverage` | The coverage floor, as the `quality` workflow runs it |
| `bun run quality mutation` | The engine mutation floor with `stryker.config.json` |
| `bun run quality mutation <computer\|browser\|live\|local\|kernel\|shell>` | The desktop cores with `apps/desktop/stryker.<scope>.json` |
| `bun run quality release` | The release mutation evidence for the current commit (`--check` only checks it) |
| `bun run quality prune <coverage\|runs>` | Shows old coverage or verification runs; `--apply` deletes them |
| `bun run quality benchmark <smoke\|release\|full>` | The runtime benchmark |

## Security

Every push to `main` runs CodeQL, Semgrep and gitleaks in the `security` workflow. Each release
verifies the final image and writes its software inventory (`bun run release security`).
[SECURITY.md](SECURITY.md) says how to report a vulnerability.

## Keys

`bun scripts/gen-release-key.ts` creates a new release signing key pair. Use it only to rotate the
key: it writes the public key into `packages/cli-core/src/release-public-key.ts` and the installer
trust root in `scripts/install.sh`, and prints the private key, which you store as the
`RELEASE_SIGNING_KEY` secret. Installed `sk` binaries trust only the old key until they update, so
rotate together with a release.
