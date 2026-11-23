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
3. Write the reviewed highlights in a file outside the repository, with a
   `## Highlights (en)` and a `## Highlights (de)` section of five to seven plain-language
   bullets each: effects for the people who use SubKit, no internal names. German uses „du“,
   „…“ and DIN 5008 (`typografie-de`, `du-sie-check`, `microcopy-ux`); English uses US spelling
   and curly quotes. Only the English section goes into the GitHub release description; the
   German one stays in the file and in the generated release notes, never on GitHub. The
   Cockpit shows them under “What’s new”, falling back to the `feat(user)` and `fix(user)`
   subjects.
4. Bump the version and regenerate the release notes with the highlights:

   ```sh
   bun run release bump <version>
   bun run gen release-notes --highlights <file>
   ```

   Commit the bump and the generated notes together. The generator keeps every highlight it
   committed before, takes the German highlights of this release from `--highlights` and reads
   only English highlights from published GitHub releases.
5. Produce the mutation evidence for this commit. It runs long and is only needed once per commit:

   ```sh
   bun run quality release
   ```

6. Push `main`, wait for the `quality` workflow of that commit, then tag:

   ```sh
   bun run release tag --highlights <file>
   ```

   `release tag` refuses a dirty tree, a commit that differs from `origin/main`, a version that
   was used before and a version without English highlights, taken from `--highlights` or an
   existing draft release. It then checks the mutation evidence
   (`bun run quality release --check`), runs the paid live model gate (`bun run verify llm-live`)
   and the release gate (`bun run verify release`), and only then writes the English highlights
   into the draft release and pushes the tag.
   To release before the mutation evidence is ready, tag with `bun run release tag --defer-mutation`.
   It skips `bun run quality release --check`, runs `bun run verify release --defer-mutation` and prints a
   loud warning. The release gate status then ends in `mutation: deferred`, and the GitHub release notes
   say "Mutation evidence: deferred". Produce the evidence afterwards with `bun run quality release`.
   Without the flag nothing changes.
7. After the `release` workflow has published, check the deployed engine:

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
| `bun run quality prune <coverage\|mutation\|runs>` | Shows old coverage, mutation or verification runs; `--apply` deletes them. Coverage and mutation runs also prune themselves: each keeps only its latest run per kind, and receipts in `.reports/mutation/release/` are never deleted |
| `bun run quality benchmark <smoke\|release\|full>` | The runtime benchmark |

## Security

Every push to `main` runs CodeQL, Semgrep and gitleaks in the `security` workflow. Each release
verifies the final image and writes its software inventory (`bun run release security`).
[SECURITY.md](SECURITY.md) says how to report a vulnerability.

## Keys

`bun scripts/gen-release-key.ts` creates a new release signing key pair. Use it only to rotate the
key: it writes the public key into `packages/cli-core/src/release-public-key.ts` and the installer
trust root in `scripts/install.sh`, and prints the private key, which you store as the
`RELEASE_SIGNING_KEY` secret. Installed `subkit` binaries trust only the old key until they update, so
rotate together with a release.

## Web Clipper

Every release attaches the Web Clipper as `subkit-clipper.zip`, so
`https://github.com/MikeBild/subkit/releases/latest/download/subkit-clipper.zip` always serves the
newest version. `bun run release bump` renders the version into its manifest.

The Web Clipper is published in the Chrome Web Store as
[`odefbnmjeehgfbanpaajiaocliccldma`](https://chromewebstore.google.com/detail/odefbnmjeehgfbanpaajiaocliccldma).
The store copy updates itself and never shows the update hint. The release ZIP stays as the
fallback for unmanaged or offline setups; an unpacked copy asks its engine for the version once a
day and shows "Update available" with a download link.

The last release step submits `assets/subkit-clipper.zip` to that store item with
`scripts/publish-clipper-store.ts`, which pins the extension ID. Without secrets it prints that it
skipped. It needs all four:

| Secret | What it is |
| --- | --- |
| `CHROME_WEB_STORE_CLIENT_ID` | OAuth client of a Google Cloud project with the Chrome Web Store API enabled |
| `CHROME_WEB_STORE_CLIENT_SECRET` | Secret of that OAuth client |
| `CHROME_WEB_STORE_REFRESH_TOKEN` | Refresh token for the scope `https://www.googleapis.com/auth/chromewebstore` |
| `CHROME_WEB_STORE_PUBLISHER_ID` | Publisher ID from the developer dashboard |

The listing texts in English and German live in `apps/clipper/store/listing.json`.
