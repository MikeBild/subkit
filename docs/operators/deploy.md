# Deploy & upgrade the engine

The production engine is a single `bun build --compile` binary at
`/usr/local/bin/engine`, run by the `subkit-engine` systemd unit. It is
**stateless** — all state lives in PostgreSQL — so a deploy is: replace the
binary, restart the unit. In-flight pg-boss jobs resume automatically.

## Version discipline

- **Never reuse a tag.** Every deploy bumps the semver in `package.json` and
  ships a new `vX.Y.Z` tag. The tag triggers `release.yml`, which builds and
  publishes the signed multi-platform assets (`engine_<os>_<arch>`,
  `SHA256SUMS`, `SHA256SUMS.sig`).
- The running version is reported by `GET /v1/health` (`"version"`).

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
