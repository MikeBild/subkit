// Auth providers live one-per-file in this directory. v1 ships `oidc` and
// `api_key`. Adding a provider is a single-file plugin that implements the
// `AuthProvider` interface and is imported into the registry at boot.
// Implemented in P2.
export {};
