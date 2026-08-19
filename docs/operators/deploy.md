# Deploy & upgrade the engine

Upgrading is a two-step operation you can do in the middle of the day: replace one file,
restart one service. Work that was in flight picks up where it left off, because none of it
lives in the process.

That is possible because the engine is a single compiled binary at `/usr/local/bin/engine`,
run by the `subkit-engine` systemd unit, and holds no state of its own — everything durable
is in PostgreSQL.

## Version discipline

- **Never reuse a tag.** Every deploy bumps the semver in `package.json` and
  ships a new `vX.Y.Z` tag. The tag triggers `release.yml`, which builds and
  publishes the signed multi-platform assets (`engine_<os>_<arch>`,
  `SHA256SUMS`, `SHA256SUMS.sig`).
- The running version is reported by `GET /v1/health` (`"version"`).

## Before a major-version upgrade

A major bump means at least one surface was removed rather than deprecated —
this project ships no backwards-compatibility shims, so an old path is gone in
the same release that replaces it. **Read that version's `CHANGELOG.md` entry
before you swap the binary**, and expect one of two failure shapes if you do not:

- **The engine refuses to boot.** Config the engine no longer has is a refusal,
  not a warning — the schema would strip an unknown section silently and the
  next settings write would erase it from disk, so a stale section is data at
  risk, and only stopping is honest. The error names every offending path, how
  many declarations are at stake, and the migration. Fix the config, then start.
- **A caller gets a 404.** A removed route or CLI command is removed. Check the
  CHANGELOG entry for what replaced it.

The pre-flight, run on the staged binary before it replaces the live one:

```bash
# Loads config FIRST, then applies migrations, then exits — without ever
# starting the HTTP listener. A config section the new version dropped
# fails here, on a unit that is still serving the old binary.
ssh root@<engine-host> '/tmp/engine-new --migrate'
```

`--version` is not a substitute: it prints and exits before any config work, by
design, so a version probe never needs a configured environment.

Note what `--migrate` really does — it *applies* the migrations rather than
rehearsing them, and migrations are forward-only. That is the same work the boot
path would do moments later, so it costs nothing extra; it does mean the
database has moved before the binary does. Take the backup before this step, not
after: [Rollback](#rollback) restores the binary, not the schema.

## Standard deploy — published-asset scp (supported path)

This is the reliable path and the one to use when self-update is not configured
(see below). It installs the exact signed release asset.

```bash
# 1. Download + checksum-verify the published Linux binary
gh release download vX.Y.Z --pattern engine_linux_x64 --pattern SHA256SUMS --dir /tmp/rel
cd /tmp/rel
EXP=$(grep 'engine_linux_x64$' SHA256SUMS | grep -oE '^[0-9a-f]{64}')
ACT=$(shasum -a 256 engine_linux_x64 | grep -oE '^[0-9a-f]{64}')
[ "$EXP" = "$ACT" ] && echo CHECKSUM_OK || { echo MISMATCH; exit 1; }

# 2. Back up the running binary, then swap + restart on the host
ssh root@<engine-host> 'cp -a /usr/local/bin/engine /usr/local/bin/engine.bak-$(curl -s localhost:3000/v1/health | grep -o "\"version\":\"[^\"]*\"")'
scp engine_linux_x64 root@<engine-host>:/tmp/engine-new
ssh root@<engine-host> 'chmod +x /tmp/engine-new && mv /tmp/engine-new /usr/local/bin/engine && systemctl restart subkit-engine'

# 3. Verify
ssh root@<engine-host> 'curl -s localhost:3000/v1/health'   # expect the new "version"
ssh root@<engine-host> 'journalctl -u subkit-engine --since "60 seconds ago" | grep -E "ready.*version|migrate.applied|hydrate.completed"'
```

`SHA256SUMS` uses a no-separator format (`<hash>engine_linux_x64`); extract the
hash with `grep -oE '^[0-9a-f]{64}'` on the matching line, not `awk '{print $1}'`.

## Probe endpoints

The engine answers four probe paths, two names for each of two probes:

| Path | Probe | Codes |
| --- | --- | --- |
| `GET /v1/health`, `GET /health` | liveness — the process is up; `db_connected` is informational | 200 |
| `GET /v1/readyz`, `GET /ready` | readiness — refuses traffic while the database is unreachable or the unit is draining | 200 / 503 |

All four are unauthenticated and answer without an `Authorization` header. The
versioned pair is the documented API contract and the only one in
`openapi.json`; the unversioned pair exists so an infrastructure probe that
knows only `/health` and `/ready` does not read a 404 as a dead service. Gate
load-balancer routing on a readiness path, never on a liveness one.

## Serving the `sk` CLI from the engine (`/install`)

Users install the CLI by running `curl -fsSL https://<engine-hostname>/install | bash`
against the engine they already talk to (chat, MCP, or API), where
`<engine-hostname>` is the DNS name the engine already knows via its
`server.public_base_url` config — always the hostname, never a bare IP (the
install script interpolates it into the profile and OAuth2 redirect URIs). That
script probes `https://<engine-hostname>/install/sk-<os>-<arch>` first and only
falls back to github.com. **While the repo is private, the GitHub fallback
returns 404 for users**, so the engine must serve the binaries itself —
otherwise the install one-liner the chat hands out dead-ends.

Stage all five client-platform binaries into `SUBKIT_BINARIES_DIR` (default
`/usr/local/share/subkit/binaries`), built straight from source with no
github.com dependency:

```bash
# On a build host with the repo checked out at the deploy tag:
bun scripts/stage-cli-binaries.ts --dir /tmp/sk-binaries --version X.Y.Z
# → sk_{darwin,linux,windows}_{arm64,x64}[.exe] + SHA256SUMS

# Ship to the engine host (address it by its DNS hostname, not an IP), then
# (re)start so a cold cache picks them up.
ssh root@<engine-hostname> 'mkdir -p /usr/local/share/subkit/binaries'
scp /tmp/sk-binaries/* root@<engine-hostname>:/usr/local/share/subkit/binaries/
ssh root@<engine-hostname> 'systemctl restart subkit-engine'

# Verify against the public hostname (the same server.public_base_url users
# hit): 200 + x-subkit-sha256 for every client platform.
curl -fsSI https://<engine-hostname>/install/sk-darwin-arm64 | grep -i x-subkit-sha256
```

The staged `SHA256SUMS` uses the two-space `sha256sum` format
(`<hash>  sk_<os>_<arch>`) that both the serving route and the install script's
`grep`/`sha256sum -c` expect — it is intentionally distinct from the
no-separator format of the release `SHA256SUMS` used by self-update. The route
does not cache the empty-directory state, so staging after the engine is already
up is picked up on the next request; the restart above is only needed if you
want it live immediately without waiting for a request to re-probe.

The all-in-one Docker image bakes these binaries in at build time (see the
`stage-cli-binaries` step in the `Dockerfile`), so containerized deploys serve
`/install/{asset}` with no extra step.

## Self-update (`engine --self-update`)

The engine can pull the latest published GitHub release and swap its own binary:

```bash
engine --self-update      # checks the latest release; installs it if NEWER
engine --rollback         # swap back to a previously retained signed binary
```

Two things to know:

- **It only moves FORWARD.** `checkForUpdate` compares versions with `isNewer`
  and never downgrades, so a self-update can never revert you to an older
  release.
- **A PRIVATE repo needs a token.** GitHub returns **404** (not 401) to
  *unauthenticated* reads of a private repo's releases. Without a token,
  self-update cannot see any release and now reports this honestly (previously
  it read as a misleading "already at latest"). To enable self-update on a
  private-repo deployment, put a read-scoped token in the unit's
  `EnvironmentFile` (`/etc/subkit/.env`):

  ```bash
  # /etc/subkit/.env
  GITHUB_TOKEN=ghp_...        # or SUBKIT_UPDATE_TOKEN=...
  ```

  then `systemctl restart subkit-engine` so the process picks it up. With the
  token set, `engine --self-update` reads the private repo's releases and
  installs the newest signed asset (Ed25519-verified against `SHA256SUMS.sig`).
  Until a token is set, use the published-asset scp above.

## Rollback

- Fast: `mv /usr/local/bin/engine.bak-<version> /usr/local/bin/engine && systemctl restart subkit-engine`.
- Or `engine --rollback` (swaps to a retained signed binary; keeps the last
  few — see `RETAINED_VERSIONS_KEEP`).
- App-level: every workflow change is an immutable version — roll a workflow
  back independently of the binary.

## Memory / OOM

The unit caps memory (`MemoryHigh=6G`, `MemoryMax=7G`) and steers the OOM killer
toward the engine (not Postgres). A killed engine restarts via `Restart=on-failure`
and resumes queued jobs. See `docs/admins/production-hardening.md` for the full
memory-containment rationale.
