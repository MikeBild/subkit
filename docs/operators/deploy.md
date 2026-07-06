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
