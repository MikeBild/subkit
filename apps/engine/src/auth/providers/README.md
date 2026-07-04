# Auth providers

The `AuthProviderRegistry` (`../registry.ts`) walks the registered providers in
order on every request and returns the first non-null `ResolvedPrincipal`. Each
provider is a single-file plugin implementing the `AuthProvider` interface from
`../types.ts`.

The registry has two layers, both assembled by `buildDefaultRegistry()` in
`../../http/server.ts` from `getConfig().auth`:

- **Machine / token auth — always available.** `api_key` and `portal_token` are
  always registered; `mcp_oauth` is registered when its own server feature flag
  (`auth.mcp_oauth.enabled`) is on. These are the programmatic + agent surface
  and are orthogonal to who owns *human* identity.
- **Human identity provider — exactly one, selected by `auth.provider`.**
  `"subkit"` (default) registers **none** — humans authenticate with
  engine-issued API keys provisioned via admin-invite. `"firebase"` and
  `"oidc"` register that external provider.

```
auth.provider: "subkit" | "firebase" | "oidc"   # default "subkit"; extensible
```

Set it via sk-cli: `sk settings set auth.provider firebase --force` then restart
(`requiresRestart`). Firebase is **first-class and permanent** — it is one value
of this enum, never removed; selecting another provider never weakens it.

## Current providers

| Provider | File | Layer | Credential shape | State |
|---|---|---|---|---|
| `api_key` | `api-key.ts` | machine (always on) | `wf_live_*` bearer / `?token=` | DB-backed API key |
| `portal_token` | `portal-token.ts` | machine (always on) | `wf_portal_*` bearer | DB-backed portal token |
| `mcp_oauth` | `mcp-oauth.ts` | machine (server-flag) | `wf_mcp_*` bearer | DB-backed access token |
| `oidc` | `oidc.ts` | human (`auth.provider=oidc`) | `subkit_session` cookie | DB-backed session + login funnel |
| `firebase` | `firebase.ts` | human (`auth.provider=firebase`) | `Authorization: Bearer <id_token>` | stateless JWT verify |

The unambiguous-prefix machine providers register first as a latency
optimisation — they reject foreign tokens before touching the DB. The
JWT/cookie human provider (if any) registers last. Ordering is performance, not
correctness: the registry returns on the first non-null principal.

## Adding a human identity provider

1. **Implement `AuthProvider`** in a new `your-provider.ts`. Only `resolve(req)`
   is required; `startLogin` / `finishLogin` / `refreshSession` / `revoke` are
   optional. `resolve()` must never throw — catch and return `null` so a bad
   credential cannot lock the door, and so the registry can try the next
   provider. Decline foreign credentials as early and cheaply as possible
   (prefix/shape check before DB or network).

2. **Add the enum value.** Add `"your-provider"` to the `auth.provider` enum in
   `AuthSection` (`../../config/schema.ts`), plus any provider-specific settings
   block (e.g. an `auth.your_provider.*` object). Use
   `.meta(global({ requiresRestart: true }))` like the neighbours.

3. **Register it.** Add one `else if (provider === "your-provider")` branch in
   `buildDefaultRegistry()` (`../../http/server.ts`) and push the name onto the
   `registered` log array. Machine providers stay registered regardless.

4. **Advertise it (optional).** If a client needs to discover the provider
   before authenticating, add a `provider`-gated entry to
   `../../http/routes/identity/providers.ts`.

5. **Label it.** Add labels for the new config leaves in
   `apps/sk/src/settings-ui/lib/config-labels.ts` (a coverage-lock test
   requires every schema leaf to have one).
