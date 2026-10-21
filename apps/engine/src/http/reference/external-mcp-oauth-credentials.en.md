---
slug: external-mcp-oauth-credentials
summary: Connect external MCP servers that require OAuth client credentials.
section: operate
order: 8
audience: operator
---
## External MCP OAuth credentials

For external MCP connectors using `oauth2_client_credentials` or
`oauth2_private_key_jwt`, configure the trusted authorization server URL as
`config.mcp.auth.issuer` before connecting. SubKit refuses to use these credentials
without that binding. Discovery cannot redirect a client secret or signed assertion
to another authorization server.

Interactive MCP OAuth stores the authorization-server issuer with the encrypted
client information and tokens. Older saved credentials without an issuer are not
reused. Providers with dynamic client registration can start a new sign-in through
the connector's OAuth setup. Recovery of older confidential clients at providers
without dynamic registration is not yet verified through the public setup APIs;
do not assume that entering an issuer restores those saved credentials. Keep such
connections out of the rollout until their recovery has been verified. Do not edit
stored credentials to bypass this check. Changing discovery metadata does not
migrate existing credentials, and a new sign-in never inherits a refresh token
issued by a different server. Review provider changes before authorizing them;
the binding does not establish that a newly selected provider is trustworthy.

