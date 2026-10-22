---
slug: run-the-engine
summary: Start the engine with Docker Compose on your own server.
section: start
path_choice: hosting
order: 3
audience: operator
---
## Run the engine

Requires Docker with Compose, OpenSSL and a POSIX shell. Use `docker-compose.yml`
from the same published release as the engine image, in a dedicated directory.
Development checkouts may reference an image that has not been published yet;
a failed image pull is not a working installation. Do not silently substitute an
older image with a newer Compose file.

Create the installation secrets once, before the first start. This command refuses
to overwrite an existing `.env` and restricts access to its owner:

```bash
(
  set -eu
  umask 077
  set -C
  install_master_key=$(openssl rand -hex 32)
  install_database_password=$(openssl rand -hex 32)
  printf 'MASTER_KEY=%s\nSUBKIT_DB_PASSWORD=%s\n' \
    "$install_master_key" "$install_database_password" > .env
)
```

After the command succeeds, start the installation:

```bash
docker compose pull && docker compose up -d --wait
curl -fsS http://localhost:3000/health
```

Keep an encrypted backup of `.env` outside this directory. `MASTER_KEY` encrypts
stored secrets; losing it makes those secrets unreadable. Never regenerate it for
an existing database. Keep the database password unchanged when reusing its volume;
changing `.env` does not change the password inside an initialized PostgreSQL database.
Never commit `.env` or share `docker compose config` output, which contains secrets.

The offline `--rewrap-master-key` command covers the settings-secret registry.
It refuses retained credentials, encrypted workflow or conversation data, approval
proofs, and other encrypted stores outside that scope. Preserve the original
`MASTER_KEY` when it refuses. The command requires explicit confirmation that all
producers have stopped and a separate stop-evidence file; expired heartbeats alone
do not establish that. Hosted maintenance of inactive owners additionally requires
an explicitly provisioned maintenance capability. Select that login through the
existing database configuration and use `--maintenance`; it receives only the
designated maintenance functions. The engine creates no database users.

For subsequent starts, run `docker compose up -d --wait` from the same directory.
`docker compose stop` stops services without deleting data. The database and object
store use named volumes; `docker compose down -v` deletes them. Keep the same Compose
project name when resuming an installation. A recovery backup needs the database,
object-store data, `.env`, and the matching Compose file and image identity together.
Test restoration in a separate installation before relying on a backup or upgrading.

The default API and database bindings are loopback-only. Complete first-run setup
locally before exposing the API. Remote access requires HTTPS and access controls;
do not expose the database or object store publicly.

Connector discovery in the supplied container supports HTTP-based documentation
sources. Optional Playwright crawling is not available out of the box. For documentation
that requires JavaScript rendering, provide an accessible OpenAPI specification or
configure the connector endpoints explicitly. A bundled browser executable alone does
not establish that the discovery integration is available.

### Backup and recovery

Use a maintenance window for a consistent backup. These steps apply to the bundled
PostgreSQL and object store; external services need their own recovery procedure.
Run commands from the installation directory with its original Compose project name.
Use a new owner-only backup directory outside the checkout, set `umask 077`, and keep
it encrypted at rest. The dump, object archive and `.env` contain sensitive data.

1. Record the running engine image identity with `docker inspect --format '{{.Image}}' "$(docker compose ps -q engine)"`.
   Preserve that image in an accessible registry or with `docker image save`, together
   with `docker-compose.yml` and `.env`. Do not rely on a mutable tag for recovery.
2. Stop writers with `docker compose stop engine`. Back up PostgreSQL with
   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.
   Check the exit status before proceeding. Keep the engine stopped until both data stores are backed up.
3. Stop the object store with `docker compose stop object-store`. Find its exact volume
   using `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -aq object-store)"`.
   Archive it read-only with `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:1.4.0-debian -C /data -cf - . > /path/to/backup/objects.tar`.
   Replace `<object-volume>` with that inspected name, not a guessed volume name.
4. Check each command succeeded, restrict all backup files to mode `0600`, and record
   their SHA-256 checksums. Restart the original installation with `docker compose up -d --wait`.
   If a backup command fails, retain the original volumes and investigate; an incomplete backup is not a recovery point.

Test recovery in a separate directory using `docker compose -p subkit-recovery` for
**every** Compose command below. First confirm that this project name has no existing
containers or volumes; choose another unused name otherwise. Copy the saved Compose
file and `.env`, preserve `MASTER_KEY` and the database password, select the saved
engine image with `SUBKIT_IMAGE`, and set unused loopback ports through
`SUBKIT_HOST_PORT` and `SUBKIT_DB_PORT`. Do not connect the recovery installation to
external writers. Before starting services, add `docker-compose.override.yml` in
the recovery directory with the following network isolation. Keep it in effect until
restored schedules, triggers and connector permissions have been reviewed; starting
the engine also starts its scheduler. Do not use this recovery project to perform
real external effects.

```yaml
networks:
  default:
    internal: true
```

1. Create fresh storage with `docker compose -p subkit-recovery create postgres object-store`.
   Inspect the new object-store container's `/data` volume as above, using the recovery
   project. Restore only into that new volume:
   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:1.4.0-debian -C /data -xf - < /path/to/backup/objects.tar`.
2. Start the new database with `docker compose -p subkit-recovery up -d --wait postgres`.
   Restore it with `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump`.
   This command replaces database contents: use it only against the new recovery project.
3. Start the recovered services with `docker compose -p subkit-recovery up -d --wait`.
   Check `/health` and `/ready` on the selected port, sign in with an existing account,
   compare workflow records and downloaded file checksums, and verify an encrypted
   credential through a controlled test. A successful HTTP health check alone does
   not prove that the database, object files and encryption key match.

This restores the same application image and a consistent backup. It does not
establish an upgrade or schema-downgrade path. Data written after the backup is not
included. Retain the original installation until recovery has been accepted.

