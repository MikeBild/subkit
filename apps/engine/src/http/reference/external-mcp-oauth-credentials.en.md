---
slug: external-mcp-oauth-credentials
summary: Connect external MCP servers over OAuth without secrets being redirected.
section: operate
order: 8
audience: operator
---
## External MCP OAuth credentials

Some external MCP servers require an OAuth sign-in before SubKit may use their tools. You need this chapter when you set up such a server as a connector or want to keep using older saved sign-ins. Afterwards every sign-in is bound to a fixed authorization server, and client secrets go only there.

OAuth is the common method by which one service grants another access. The authorization server issues the tokens for it.

A remote authorization server must use HTTPS. A local one on `localhost`, `127.0.0.1` or `[::1]`, announced by a local MCP server, also works over `http`. More on that in “Connect local services”.

### Sign-in with client credentials

For connectors using `oauth2_client_credentials` or `oauth2_private_key_jwt`, enter the trusted authorization server URL as `config.mcp.auth.issuer` before connecting. Without that binding SubKit does not use the credentials. Discovery, the automatic lookup of server addresses, then cannot redirect a client secret or signed assertion to another authorization server.

### Interactive sign-in

With interactive MCP OAuth, SubKit stores the authorization-server issuer together with the encrypted client information and tokens. SubKit does not reuse older saved credentials without an issuer. For providers with dynamic client registration, you start a new sign-in through the connector's OAuth setup.

You can save such a connector before anyone has signed in, also from a chat. It then waits in the state “needs sign-in”, and a 401 from the server before the sign-in does not stop the save. The sign-in link from the connector or the chat starts the browser sign-in with PKCE:

- **Dynamic client registration:** you enter no client. On the first sign-in SubKit registers a client at the authorization server and stores it with the issuer. If the server allows public clients (`none` in `token_endpoint_auth_methods_supported`), SubKit registers as a public client with PKCE and stores no secret. Otherwise it registers a confidential client. A repeated or interrupted sign-in reuses this client and does not register a new one.
- **Pre-registered client:** a client ID without a secret is configuration, not a secret. Set `config.mcp.auth.client_id`, optionally `token_endpoint_auth_method: "none"`. A client secret always goes through the secure form. Without `config.mcp.auth.issuer`, SubKit discovers the authorization server from the server's metadata when you save and binds the client to it. If that fails, SubKit refuses the save with `mcp_oauth_issuer_unresolved`. Then set `config.mcp.auth.issuer` to the authorization server URL yourself.

### Older credentials without dynamic registration

Whether older confidential clients at providers without dynamic registration can be recovered through the public setup APIs is not verified yet. Do not assume that entering an issuer afterwards restores those credentials. Put such connections into service only once their recovery has been verified. Do not edit stored credentials to bypass this check.

Changed discovery metadata does not migrate existing credentials. A new sign-in never inherits a refresh token issued by a different server. Review a provider change before you authorize it: the binding says nothing about whether a newly selected provider is trustworthy.
