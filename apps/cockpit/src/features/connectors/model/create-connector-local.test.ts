import { describe, expect, test } from "bun:test";
import { addressProblem } from "@/lib/connector-address";
import { translate } from "@/lib/i18n";
import {
  type ConnectorEditDraft,
  type ConnectorEditPrior,
  type ConnectorTarget,
  commandLineOf,
  confirmCommandErrorKey,
  connectorCreateBody,
  connectorEditProblem,
  defaultSignIn,
  draftCommandLine,
  EMPTY_LOCAL_COMMAND,
  EMPTY_OAUTH_CLIENT,
  EMPTY_SIGNED_JWT,
  engineCommandLine,
  headerNameProblem,
  type LocalCommandFields,
  localCommandHash,
  localCommandProblem,
  localCommandUnconfirmed,
  localConnectorErrorKey,
  manualConnectorProblem,
  manualCredentialBody,
  manualSourceProblem,
  showsTls,
} from "./create-connector-model";

const TARGETS: ConnectorTarget[] = ["web", "mcp"];

function draftOf(overrides: Partial<ConnectorEditDraft> = {}): ConnectorEditDraft {
  return {
    name: "Billing",
    address: "https://api.example.com",
    signIn: "key",
    secret: "",
    header: "",
    headerValues: {},
    oauth: EMPTY_OAUTH_CLIENT,
    signedJwt: EMPTY_SIGNED_JWT,
    ...overrides,
  };
}

describe("local addresses: http and https on this computer, https everywhere else", () => {
  const LOCAL = [
    "http://localhost:8931/mcp",
    "https://localhost/mcp",
    "http://api.localhost:3000",
    "http://127.0.0.1:8080/mcp",
    "http://127.42.0.9",
    "http://[::1]:8931/mcp",
    "http://host.docker.internal:8931/mcp",
    "https://gateway.docker.internal",
  ];

  test("a local server is allowed with http and https for every target", () => {
    for (const address of LOCAL)
      for (const target of TARGETS) expect(addressProblem(address, target)).toBeNull();
  });

  test("a remote MCP server needs https, a host without dot is fine", () => {
    expect(addressProblem("https://mcp.example.com/mcp", "mcp")).toBeNull();
    expect(addressProblem("https://intranet/mcp", "mcp")).toBeNull();
    expect(addressProblem("http://mcp.example.com/mcp", "mcp")).toBe(
      "create.connector.addressInvalid",
    );
  });

  test("a remote web service keeps https with a dotted host", () => {
    expect(addressProblem("https://api.example.com", "web")).toBeNull();
    expect(addressProblem("https://intranet", "web")).toBe("create.connector.addressInvalid");
    expect(addressProblem("http://api.example.com", "web")).toBe("create.connector.addressInvalid");
  });

  test("lookalikes and other schemes stay out", () => {
    for (const address of [
      "http://0.0.0.0:8931",
      "http://localhost.example.com",
      "http://10.0.0.5",
      "ftp://localhost",
      "localhost:8931",
      "",
    ])
      expect(addressProblem(address, "mcp")).toBe("create.connector.addressInvalid");
  });

  test("the manual form and the edit form use the same address rule", () => {
    const ok = {
      target: "mcp" as const,
      signIn: "none" as const,
      slug: "local",
      address: "http://localhost:8931/mcp",
      secret: "",
      oauth: EMPTY_OAUTH_CLIENT,
      callbackUrl: null,
    };
    expect(manualConnectorProblem(ok)).toBeNull();
    expect(manualConnectorProblem({ ...ok, address: "http://mcp.example.com" })).toBe(
      "create.connector.addressInvalid",
    );
    const prior: ConnectorEditPrior = {
      driver: "http",
      authType: "none",
      name: "Local",
      address: "https://api.example.com",
      config: {},
      headerNames: [],
    };
    expect(
      connectorEditProblem(
        prior,
        draftOf({ address: "http://127.0.0.1:3000", signIn: "none" }),
        null,
      ),
    ).toBeNull();
    expect(
      connectorEditProblem(
        prior,
        draftOf({ address: "http://api.example.com", signIn: "none" }),
        null,
      ),
    ).toBe("create.connector.addressInvalid");
  });
});

describe("default sign-in follows the address until someone picks one", () => {
  test("local addresses and local commands start without sign-in", () => {
    expect(defaultSignIn("mcp", "address", "http://localhost:8931/mcp")).toBe("none");
    expect(defaultSignIn("web", "address", "http://127.0.0.1:3000")).toBe("none");
    expect(defaultSignIn("mcp", "command", "")).toBe("none");
  });

  test("remote and empty addresses start with a key", () => {
    expect(defaultSignIn("mcp", "address", "https://mcp.example.com/mcp")).toBe("key");
    expect(defaultSignIn("web", "address", "")).toBe("key");
    expect(defaultSignIn("web", "command", "")).toBe("key");
  });

  test("certificate options only show for a local https address", () => {
    expect(showsTls("mcp", "address", "https://localhost:8443/mcp")).toBe(true);
    expect(showsTls("web", "address", "https://127.0.0.1:8443")).toBe(true);
    expect(showsTls("mcp", "address", "http://localhost:8931/mcp")).toBe(false);
    expect(showsTls("mcp", "address", "https://mcp.example.com")).toBe(false);
    expect(showsTls("mcp", "command", "https://localhost")).toBe(false);
  });
});

describe("a key for an MCP server goes as Bearer or in a header of its own", () => {
  const base = {
    target: "mcp" as const,
    signIn: "key" as const,
    slug: "local",
    address: "https://mcp.example.com/mcp",
    secret: "sk-1",
    oauth: EMPTY_OAUTH_CLIENT,
    callbackUrl: null,
  };

  test("header mode needs a valid header name that MCP does not own", () => {
    expect(manualConnectorProblem({ ...base, keyMode: "header", header: "X-API-Key" })).toBeNull();
    expect(manualConnectorProblem({ ...base, keyMode: "header", header: " " })).toBe(
      "create.template.headerMissing",
    );
    expect(manualConnectorProblem({ ...base, keyMode: "header", header: "X API" })).toBe(
      "create.connector.headerNameInvalid",
    );
    for (const name of [
      "Mcp-Session-Id",
      "mcp-protocol-version",
      "Last-Event-ID",
      "Host",
      "content-length",
    ])
      expect(headerNameProblem(name)).toBe("create.connector.headerNameReserved");
    expect(manualConnectorProblem({ ...base, keyMode: "bearer", header: "" })).toBeNull();
  });

  test("the auth type and credential follow the chosen mode", () => {
    const body = { ...base, name: "Local", address: base.address };
    expect(connectorCreateBody({ ...body, keyMode: "bearer" }).auth_type).toBe("bearer");
    expect(connectorCreateBody({ ...body, keyMode: "header" }).auth_type).toBe("header");
    const credential = {
      target: "mcp" as const,
      source: "address" as const,
      signIn: "key" as const,
      secret: " sk-1 ",
      command: EMPTY_LOCAL_COMMAND,
    };
    expect(manualCredentialBody({ ...credential, keyMode: "bearer", header: "" })).toEqual({
      mode: "bearer",
      token: "sk-1",
    });
    expect(manualCredentialBody({ ...credential, keyMode: "header", header: "X-API-Key" })).toEqual(
      { mode: "header", headers: { "X-API-Key": "sk-1" } },
    );
    expect(
      manualCredentialBody({ ...credential, target: "web", keyMode: "header", header: "X" }),
    ).toEqual({ mode: "bearer", token: "sk-1" });
  });

  test("TLS settings go to the right block and only for a local https address", () => {
    const tls = { caPem: " PEM ", skipVerify: true };
    const body = {
      signIn: "none" as const,
      name: "Local",
      slug: "local",
      tls,
    };
    expect(
      connectorCreateBody({ ...body, target: "mcp", address: "https://localhost:8443/mcp" }).config,
    ).toEqual({ mcp: { transport: "http", tls: { ca_pem: "PEM", skip_verify: true } } });
    expect(
      connectorCreateBody({ ...body, target: "web", address: "https://127.0.0.1:8443" }).config,
    ).toEqual({ tls: { ca_pem: "PEM", skip_verify: true } });
    expect(
      connectorCreateBody({ ...body, target: "mcp", address: "https://mcp.example.com" }).config,
    ).toBeUndefined();
  });
});

describe("an MCP server started as a local command", () => {
  const command: LocalCommandFields = {
    command: " docker ",
    args: "mcp\n gateway \n\nrun\n--name\nmy server",
    env: [
      { name: "LOG_LEVEL", value: "debug", secret: false },
      { name: "API_TOKEN", value: "t0k3n", secret: true },
      { name: "", value: "", secret: false },
    ],
    cwd: "/Users/me/project",
  };

  test("the command is required and env names and the folder are checked", () => {
    expect(localCommandProblem(command)).toBeNull();
    expect(localCommandProblem({ ...command, command: " " })).toBe("connectorLocal.commandMissing");
    expect(
      localCommandProblem({ ...command, env: [{ name: "1BAD", value: "x", secret: false }] }),
    ).toBe("connectorLocal.envNameInvalid");
    expect(
      localCommandProblem({
        ...command,
        env: [
          { name: "A", value: "1", secret: false },
          { name: "A", value: "2", secret: true },
        ],
      }),
    ).toBe("connectorLocal.envNameTwice");
    expect(localCommandProblem({ ...command, cwd: "project" })).toBe("connectorLocal.cwdInvalid");
    expect(localCommandProblem({ ...command, cwd: "" })).toBeNull();
    expect(
      manualSourceProblem({
        target: "mcp",
        source: "command",
        slug: "gw",
        address: "",
        command: EMPTY_LOCAL_COMMAND,
      }),
    ).toBe("connectorLocal.commandMissing");
  });

  test("the body has no address, signs in with secret env only, never holds a secret value", () => {
    const body = connectorCreateBody({
      target: "mcp",
      source: "command",
      signIn: "key",
      name: "Gateway",
      slug: "gateway",
      address: "https://ignored.example.com",
      command,
    });
    expect(body).not.toHaveProperty("base_url");
    expect(body.auth_type).toBe("header");
    expect(body.config).toEqual({
      mcp: {
        transport: "stdio",
        auth: { kind: "header" },
        command: "docker",
        args: ["mcp", "gateway", "run", "--name", "my server"],
        env: { LOG_LEVEL: "debug" },
        env_secret_names: ["API_TOKEN"],
        cwd: "/Users/me/project",
      },
    });
    expect(JSON.stringify(body)).not.toContain("t0k3n");
    const open = connectorCreateBody({
      target: "mcp",
      source: "command",
      signIn: "none",
      name: "Gateway",
      slug: "gateway",
      address: "",
      command: { ...command, env: [] },
    });
    expect(open.auth_type).toBe("none");
    expect(open.config).toMatchObject({ mcp: { auth: { kind: "none" } } });
  });

  test("the serialized command body omits base_url so the engine accepts it", () => {
    const body = connectorCreateBody({
      target: "mcp",
      source: "command",
      signIn: "none",
      name: "Gateway",
      slug: "gateway",
      address: "",
      command,
    });
    expect(Object.keys(JSON.parse(JSON.stringify(body)))).not.toContain("base_url");
  });

  test("secret values go into the credential, and only when there are some", () => {
    const p = {
      target: "mcp" as const,
      source: "command" as const,
      signIn: "none" as const,
      keyMode: "bearer" as const,
      header: "",
      secret: "",
    };
    expect(manualCredentialBody({ ...p, command })).toEqual({
      mode: "header",
      headers: { API_TOKEN: "t0k3n" },
    });
    expect(manualCredentialBody({ ...p, command: { ...command, env: [] } })).toBeNull();
  });

  test("the command line shows names only, quotes spaces and names the folder", () => {
    const line = draftCommandLine(command);
    expect(line).toBe(
      "cd /Users/me/project && API_TOKEN=… LOG_LEVEL=… docker mcp gateway run --name 'my server'",
    );
    expect(line).not.toContain("t0k3n");
    expect(line).not.toContain("debug");
  });

  test("a saved connector shows its command line and whether a person allowed it", () => {
    const config = {
      mcp: {
        transport: "stdio",
        command: "docker",
        args: ["mcp", "gateway", "run"],
        env: { LOG_LEVEL: "debug" },
        env_secret_names: ["API_TOKEN"],
      },
    };
    expect(commandLineOf(config)).toBe("API_TOKEN=… LOG_LEVEL=… docker mcp gateway run");
    expect(localCommandUnconfirmed(config)).toBe(true);
    expect(localCommandUnconfirmed({ mcp: { ...config.mcp, confirmed_command_hash: "abc" } })).toBe(
      false,
    );
    expect(commandLineOf({ mcp: { transport: "http" } })).toBeNull();
    expect(localCommandUnconfirmed({ mcp: { transport: "http" } })).toBe(false);
  });

  test("engine errors about local commands have words in both languages", () => {
    const run = [
      "mcp_local_command_unconfirmed",
      "mcp_stdio_disabled",
      "mcp_stdio_unavailable_in_container",
      "mcp_stdio_capacity",
      "mcp_stdio_start_failed",
    ];
    const confirmOnly = [
      "mcp_not_stdio",
      "mcp_local_command_self_confirmation",
      "self_confirm_not_allowed",
      "permission_denied",
      "mcp_local_command_changed",
    ];
    for (const code of [...run, ...confirmOnly]) {
      const key = confirmCommandErrorKey(code);
      expect(key).not.toBeNull();
      if (!key) continue;
      expect(translate("de", key)).not.toBe(key);
      expect(translate("en", key)).not.toBe(key);
    }
    for (const code of run) expect(localConnectorErrorKey(code)).not.toBeNull();
    for (const code of confirmOnly) expect(localConnectorErrorKey(code)).toBeNull();
    expect(localConnectorErrorKey("something_else")).toBeNull();
    expect(translate("de", "connectorLocal.confirm.allow")).not.toBe(
      translate("en", "connectorLocal.confirm.allow"),
    );
    expect(translate("de", "connectorLocal.confirm.allow").length).toBeGreaterThan(0);
    expect(translate("en", "connectorLocal.confirm.allow")).toBe("Allow and start command");
  });
});

describe("the confirmation names the exact command the engine will start", () => {
  test("the hash matches the engine's identity of the same command", async () => {
    expect(
      await localCommandHash({
        mcp: {
          transport: "stdio",
          command: "docker",
          args: ["mcp", "gateway", "run"],
          env: { LOG_LEVEL: "debug", A: "1" },
          env_secret_names: ["API_TOKEN", "API_TOKEN"],
          cwd: "/Users/me/project",
          confirmed_command_hash: "ignored",
        },
      }),
    ).toBe("19a22e9bc63f419f1de321f37d47618c5b881c60c5f582f2208782df78b8ac48");
    expect(await localCommandHash({ mcp: { transport: "stdio", command: "npx", cwd: "" } })).toBe(
      "9b7bdc707fdffc14ee6157321b1a761f2fa1f597a8d0a7a637b770f90c7e2b1a",
    );
    expect(await localCommandHash({ mcp: { transport: "http" } })).toBeNull();
  });
});

describe("the engine's own command line, to match a refused confirmation", () => {
  test("quotes like the engine and leaves out env and folder", () => {
    expect(
      engineCommandLine({
        mcp: {
          transport: "stdio",
          command: "docker",
          args: ["mcp", "gateway", "run", "my server"],
          env: { A: "1" },
          cwd: "/tmp",
        },
      }),
    ).toBe("docker mcp gateway run 'my server'");
  });
});
