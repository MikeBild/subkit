---
slug: run-the-engine
summary: Run SubKit yourself with Docker Compose on your own server.
section: start
path_choice: hosting
order: 3
audience: operator
---
## Run the engine

Afterwards SubKit runs on your own server: the engine with the Cockpit, a PostgreSQL database and an object store, started with Docker Compose.
Database, files and keys stay on your server.

### In short

1. Install Docker with Compose and OpenSSL on your server.
2. Download [`docker-compose.yml`](https://github.com/MikeBild/subkit/releases/latest/download/docker-compose.yml) of the newest release into an empty directory.
3. Create `.env` with `MASTER_KEY` and `SUBKIT_DB_PASSWORD`, using the command below.
4. Start everything with `docker compose pull && docker compose up -d --wait`.
5. Create the admin account and connect your AI key with `docker compose exec engine subkit init`, as described in “First-run setup”.
6. Open `http://localhost:3000`. You land in the Cockpit.

The details follow.

You need Docker with Compose, OpenSSL and a POSIX shell.
Download `docker-compose.yml` into a dedicated directory. It always comes from the newest release and starts the engine image of that release:

```bash
mkdir subkit && cd subkit
curl -fsSLO https://github.com/MikeBild/subkit/releases/latest/download/docker-compose.yml
```

Every setting and its default is in [`subkit.config.example.json`](https://github.com/MikeBild/subkit/releases/latest/download/subkit.config.example.json). You need it only when you change a setting by file, as described in “Settings”.
Use only published release images. If pulling the image fails, the installation is not finished, even if other services start.
Do not combine an older image with a newer Compose file.

Create the installation secrets once, before the first start. The command does not overwrite an existing `.env` and makes it readable only by its owner:

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

Then set up the admin account and AI provider as described in “First-run setup”.

### Protect keys and passwords

`MASTER_KEY` encrypts all stored secrets. If it is lost, those secrets can no longer be read.
Keep an encrypted backup of `.env` outside the installation directory.
Never regenerate `MASTER_KEY` for an existing database.

Also keep the database password unchanged when you reuse the database volume.
Changing `.env` does not change the password inside an already initialized PostgreSQL database.
Never commit `.env`. Do not share the output of `docker compose config` either, because it contains the secrets.

If you need to change `MASTER_KEY`, the offline command `--rewrap-master-key` re-encrypts the stored settings secrets with the new key.
It covers only these settings secrets. If other encrypted data exists, such as retained credentials, encrypted workflow or chat content, or approval proofs, it refuses.
In that case, keep the original `MASTER_KEY`.

The command runs only when all writing services have stopped.
You confirm this explicitly with `--all-producers-stopped` and back it with a separate file through `--stop-evidence-file`. Missing signs of life are not enough as proof.
If you run the database with a dedicated maintenance login, select it through the existing database configuration and pass `--maintenance`. That login receives only the designated maintenance functions.
The engine creates no database users.

### Start, stop and expose

For later starts, run `docker compose up -d --wait` from the same directory.
`docker compose stop` stops the services without deleting data.
The database and object store live in named volumes; `docker compose down -v` deletes them.
Keep the same Compose project name when you continue an installation.

At first, the API and database are reachable only over loopback, that is, only from the server itself.
Complete the first-run setup locally before you expose the API.
Access from outside needs HTTPS and access control. Never expose the database or object store publicly.

A recovery needs the database, object-store data, `.env`, the matching Compose file and the image identity together.
Test recovery in a separate installation before you rely on a backup or upgrade. The steps are under “Backup and recovery”.

### Keep workspaces apart in the database

The engine uses PostgreSQL row level security as an extra wall between workspaces. For tables with especially sensitive data, the database itself then returns only rows of the workspace that is currently working. This covers stored secrets, tool approvals, inbound webhooks, subscriptions, chat workspaces, push subscriptions, the run state of workflows and the settings of sign-in providers.

For this, the engine needs the database role `subkit_tenant`. With the supplied `docker-compose.yml` you do nothing: the engine sets up the role itself when it starts.

With your own PostgreSQL database, the engine login may lack the right to create roles. Row level security then stays off, but the engine starts and works as before. It never blocks the start because of this. The log says “row security is off” and names the statements to run.

To switch it on, a database administrator runs the following once, as a superuser or as a role with `CREATEROLE`. Replace `<engine login role>` with the role the engine signs in with:

```sql
CREATE ROLE subkit_tenant NOLOGIN NOBYPASSRLS;
GRANT subkit_tenant TO "<engine login role>";
```

Then restart the engine. At its next start, it finds the role, gives it access to its tables and switches row level security on. Instead, you can also give the engine login the right to create roles (`CREATEROLE`). The engine then sets up the role itself.

Good to know:

- `subkit_tenant` cannot sign in. It is not a database user. The engine only switches to it while it works for one workspace.
- Roles are not part of a database dump. When you restore a backup into another database server, create the role there first, as described under “Backup and recovery”. If the role is missing anyway, stored secrets cannot be read until it exists again. The log names this case. Run the two statements again and restart the engine.
- If the log says the role is a superuser or has `BYPASSRLS`, row level security does not restrict it. Fix this with `ALTER ROLE subkit_tenant NOSUPERUSER NOBYPASSRLS;`.

### Browser crawling for connector discovery

The supplied image contains no browser and no Node.js.
Connector discovery therefore looks for a service's documentation over HTTP: OpenAPI, GraphQL, Swagger UI, `llms.txt` and HTML pages.
When none of them finds the documentation, the result names the missing piece: “browser discovery is not available”.
If the documentation needs JavaScript to display, provide a reachable OpenAPI specification or enter the connector endpoints yourself.

Browser crawling runs only when both conditions hold:

- `SUBKIT_PLAYWRIGHT_ENTRY` names an installed Playwright module with its Chromium build,
  readable by the container user (uid 1001), for example in your own image derived
  from the SubKit image.
- The outbound network guard is not strict. The container starts with `NODE_ENV=production`
  and therefore strict; it refuses browser discovery. The setting `egress.mode: permissive`
  also allows private and loopback addresses for every connector. Choose it only behind
  a network boundary you have reviewed.

A derived image is yours to maintain: keep Playwright and the browser updated, scan it
and ship the browser licenses. This path is not part of the release checks.

### Backup and recovery

A backup copies the whole installation and restores it with the same image.
To move only a workspace's own workflows, connectors, skills and knowledge to another engine, export a package instead, as described in “Use the subkit CLI on your machine”.

Plan a maintenance window for a consistent backup.
These steps apply to the bundled PostgreSQL and object store; external services need their own procedure.
Run the commands from the installation directory with its original Compose project name.
Create a new backup directory outside the installation directory, readable only by its owner, set `umask 077` and keep it encrypted.
The dump, object archive and `.env` contain sensitive data.

1. Record the running engine image identity with `docker inspect --format '{{.Image}}' "$(docker compose ps -q engine)"`.
   Preserve that image in a reachable registry or with `docker image save`, together
   with `docker-compose.yml` and `.env`. Do not rely on a mutable tag for recovery.
2. Stop writing services with `docker compose stop engine`. Back up PostgreSQL with
   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.
   Check the exit status before you continue. Keep the engine stopped until both data stores are backed up.
3. Stop the object store with `docker compose stop object-store`. Find its exact volume
   using `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -aq object-store)"`.
   Archive it read-only with `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:@@BUN_VERSION@@-debian -C /data -cf - . > /path/to/backup/objects.tar`.
   Replace `<object-volume>` with that inspected name, not a guessed one.
4. Check that each command succeeded. Set all backup files to mode `0600` and record
   their SHA-256 checksums. Restart the original installation with `docker compose up -d --wait`.
   If a backup command fails, keep the original volumes and find the cause. An incomplete backup is not a recovery point.

Test recovery in a separate directory. Use `docker compose -p subkit-recovery` there for **every** Compose command below.
First check that this project name has no containers or volumes yet; otherwise choose another unused name.

Copy the saved Compose file and `.env` into it and keep `MASTER_KEY` and the database password.
Select the saved engine image with `SUBKIT_IMAGE` and set free loopback ports through `SUBKIT_HOST_PORT` and `SUBKIT_DB_PORT`.
Do not connect the test installation to external services that write data.

Starting the engine also starts its scheduler. Before the start, add a `docker-compose.override.yml` with this network isolation to the recovery directory.
Keep it in effect until you have reviewed restored schedules, triggers and connector permissions. Do not trigger real external effects through this project.

```yaml
networks:
  default:
    internal: true
```

1. Create fresh storage with `docker compose -p subkit-recovery create postgres object-store`.
   Inspect the new object-store container's `/data` volume as above, using the recovery
   project. Restore only into that new volume:
   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:@@BUN_VERSION@@-debian -C /data -xf - < /path/to/backup/objects.tar`.
2. Start the new database with `docker compose -p subkit-recovery up -d --wait postgres`.
   The dump refers to the role `subkit_tenant`, but roles are not part of it. Create the role first with `docker compose -p subkit-recovery exec -T postgres psql -U subkit -d subkit -c 'CREATE ROLE subkit_tenant NOLOGIN NOBYPASSRLS; GRANT subkit_tenant TO subkit;'`.
   Then restore the database with `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump`.
   This command replaces database contents. Use it only against the new recovery project.
3. Start the recovered services with `docker compose -p subkit-recovery up -d --wait`.
   Check `/health` and `/ready` on the selected port and sign in with an existing account.
   Compare workflow records and downloaded file checksums, and verify an encrypted credential through a controlled test.
   A successful health check alone does not prove that the database, object files and key match.

This restores the same image and a consistent backup. It does not test an upgrade or a schema downgrade.
Data written after the backup is missing.
Keep the original installation until the recovery has been accepted.
