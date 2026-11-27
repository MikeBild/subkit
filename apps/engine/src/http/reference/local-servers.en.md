---
slug: local-servers
summary: Connect services that run on your own computer, such as a local MCP server, an API or a database.
section: operate
order: 12
audience: operator
---
## Connect local services

Some services run right next to SubKit: an MCP server on your laptop, an API in a development container, a PostgreSQL database on your machine. You need this chapter when you want to connect such a local service as a connector. Afterwards SubKit reaches it over `localhost` or `host.docker.internal`, with or without sign-in, over `http` or `https`.

A local service is one whose address points to your own computer. Every connector type can use one: HTTP, GraphQL, S3, SFTP, PostgreSQL and MCP. MCP servers can also run as a command (stdio), which SubKit starts itself.

### Where local services work

SubKit can only reach a local service when the engine runs on the same computer.

| Where SubKit runs | Local services |
| --- | --- |
| SubKit Desktop on macOS, local workspace | Yes, including stdio MCP servers |
| Engine started directly on your computer (`bun`) | Yes; stdio MCP servers after you turn them on |
| Engine in Docker on your computer | Yes, through `http://host.docker.internal:<port>`; no stdio MCP servers |
| SubKit Cloud | No |
| SubKit Desktop connected to SubKit Cloud | No, because the engine runs in the cloud |
| SubKit Desktop on Windows | No, the local workspace is not available on Windows yet |

### Which addresses count as local

A connector counts as local when its own address uses one of these hosts:

- `localhost` and names ending in `.localhost`
- `127.0.0.1` and every other address that starts with `127.`
- `[::1]`
- `host.docker.internal`, the address of your computer as seen from inside a Docker container

Both `http://` and `https://` work, with any port, for example `http://localhost:8931/mcp` or `https://127.0.0.1:8443`. `0.0.0.0` is not a valid target.

The connector reaches only its own address. A remote connector can never reach a local address, not even through a redirect or a sign-in address it announces. A local connector cannot jump to a different local port either. The only exception is the local authorization server that a local MCP server names for its OAuth sign-in. Other private network addresses, such as `192.168.x.x`, stay blocked.

### Example: a local MCP server without sign-in

Say you start the Playwright MCP server on your computer:

```bash
npx @playwright/mcp@latest --port 8931
```

1. In the Cockpit, open “Connectors” and choose “Add connector”.
2. Choose MCP and enter `http://localhost:8931/mcp` as the address.
3. Leave the sign-in at “None”. That is the default for local addresses.
4. Save. SubKit checks the connection and lists the server’s tools.

You can also ask in the chat: “Connect my MCP server on localhost:8931.” SubKit creates the same connector.

If the engine runs in Docker, enter `http://host.docker.internal:8931/mcp` instead.

### Sign-in

Local services start without sign-in. If your service expects one, choose it in the connector:

- **API key:** SubKit sends the key as `Authorization: Bearer <key>` or in a header you name, for example `X-API-Key`.
- **OAuth (MCP):** The MCP server names its own authorization server, which may also run locally, for example on `http://localhost:9000`. Sign in once in the browser. After that, SubKit renews the sign-in on its own, even when `server.public_base_url` is not set.

HTTPS is required only for remote authorization servers. A local one on `localhost` works over `http`.

### HTTPS with a local certificate

Many local services use a certificate from a local certificate authority (CA), for example one made with `mkcert`. SubKit does not trust such a CA by default. You have two options:

1. **Add the CA (recommended):** Paste the CA certificate in PEM format into the connector. With `mkcert`, `mkcert -CAROOT` shows the folder; the file is `rootCA.pem`. In the configuration it lives at `config.tls` for HTTP and GraphQL connectors and at `config.mcp.tls` for MCP connectors. SubKit Desktop also trusts the CAs in the macOS keychain, where `mkcert -install` puts its CA.
2. **“Don’t verify certificate (local only)”:** SubKit then accepts any certificate from this address. Use this only for tests on your own computer. The Cockpit shows a warning.

Both options apply only to local addresses. For remote addresses, SubKit always verifies the certificate.

### MCP servers by command (stdio)

Some MCP servers do not listen on a port. They run as a program that SubKit starts and talks to through its input and output. That is called stdio. Examples:

```bash
docker mcp gateway run
npx @playwright/mcp@latest
```

In the connector you enter the command, its arguments, environment variables and optionally a working folder. Mark secret values as secret; SubKit stores them encrypted.

stdio runs only where the engine runs directly on your computer: in SubKit Desktop and in an engine started with `bun`. An engine in a Docker container refuses stdio. Use an `http` address through `host.docker.internal` there instead.

#### Confirm before the first start

SubKit starts a command only after a person has confirmed it. The chat and the Cockpit may enter a command, but they do not start it.

- Confirmation needs the permission `connectors:confirm_local_command`. By default only the owner and admin roles have it.
- The person who entered or changed the command cannot confirm it themselves. The exception is the local workspace in SubKit Desktop, where you are the only person.
- The confirmation dialog shows the full command: program, arguments, names of the environment variables and working folder.
- An answer from the AI model never counts as confirmation.
- Every change to command, arguments, environment or working folder removes the confirmation. SubKit then asks again.

#### What the started program sees

The program does not inherit the engine’s environment. Engine secrets such as `MASTER_KEY` or `DATABASE_URL` stay hidden from it. It receives only:

- `PATH` and `HOME`
- `DOCKER_HOST`, `DOCKER_CONFIG` and `DOCKER_CONTEXT`, when they are set
- the environment variables you entered in the connector, including the secret ones

SubKit Desktop reads `PATH` from your login shell. That way it finds `docker`, `npx` and other tools from Homebrew even when you start SubKit from the Finder.

SubKit starts a program on first use and stops it after a period without requests. If it crashes, SubKit restarts it with a growing delay. Its error output appears, redacted, in the logs and in the connection check.

### Settings

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `connectors.local_servers` | `allow`, `deny` | `allow` | Allows or blocks local addresses for all connectors. Takes effect immediately, without a restart. |
| `connectors.mcp.stdio` | `auto`, `on`, `off` | `auto` | `auto` turns stdio on in the Desktop local workspace and off elsewhere. `on` turns it on for an engine on your computer and is refused inside a container. |
| `connectors.mcp.stdio_limits` | see “Settings” | | Startup timeout, idle time, maximum number of processes and the size of the kept error output. |

You do not need `egress.mode: permissive` for local services. That setting opens all private addresses for all connectors; local services are allowed without it.

### Troubleshooting

| What you see | Cause | What to do |
| --- | --- | --- |
| “Connection refused” with `localhost` while the engine runs in Docker | Inside the container, `localhost` is the engine itself. | Use `http://host.docker.internal:<port>`. On Linux, the service must listen on `0.0.0.0` or on the Docker bridge, not only on `127.0.0.1`. |
| TLS or certificate error on `https://localhost` | SubKit does not know the local CA. | Add the CA as PEM to the connector (for `mkcert`: `rootCA.pem`). |
| `mcp_local_command_unconfirmed` | Nobody has confirmed the command yet, or it changed after the confirmation. | Ask a person with `connectors:confirm_local_command` to confirm it. |
| `mcp_stdio_unavailable_in_container` | The engine runs in a Docker container. | Run the server over `http` and connect it through `host.docker.internal`, or use SubKit Desktop or an engine on your computer. |
| `docker` or `npx` not found in SubKit Desktop | The program is not in the `PATH` of your login shell. | Add its folder to `PATH` in your shell profile, for example `~/.zprofile`, and restart SubKit Desktop. |
| `local_target_from_remote_origin` | A remote service tried to redirect SubKit to a local address. | This is blocked on purpose. Connect the local service with its own connector. |
| Local address blocked on a self-hosted engine | `connectors.local_servers` is set to `deny`. | Set it to `allow`. |
