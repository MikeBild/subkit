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

### Sign-in with client credentials

For connectors using `oauth2_client_credentials` or `oauth2_private_key_jwt`, enter the trusted authorization server URL as `config.mcp.auth.issuer` before connecting. Without that binding SubKit does not use the credentials. Discovery, the automatic lookup of server addresses, then cannot redirect a client secret or signed assertion to another authorization server.

### Interactive sign-in

With interactive MCP OAuth, SubKit stores the authorization-server issuer together with the encrypted client information and tokens. SubKit does not reuse older saved credentials without an issuer. For providers with dynamic client registration, you start a new sign-in through the connector's OAuth setup.

### Older credentials without dynamic registration

Whether older confidential clients at providers without dynamic registration can be recovered through the public setup APIs is not verified yet. Do not assume that entering an issuer afterwards restores those credentials. Put such connections into service only once their recovery has been verified. Do not edit stored credentials to bypass this check.

Changed discovery metadata does not migrate existing credentials. A new sign-in never inherits a refresh token issued by a different server. Review a provider change before you authorize it: the binding says nothing about whether a newly selected provider is trustworthy.
