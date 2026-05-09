// Ed25519 public key used to verify signatures over `SHA256SUMS` for
// releases of this project. Issue #151 P0-3.
//
// The public key is, by definition, *public* — committing it here is
// safe and intentional. The matching private key is held only as the
// `RELEASE_SIGNING_KEY` GitHub Actions secret. The release workflow
// signs `SHA256SUMS` with that secret and uploads `SHA256SUMS.sig` as
// a release asset; `performUpdate()` (in `./updater.ts`) refuses to
// install any binary whose `SHA256SUMS` does not validate against this
// key.
//
// **Generating / rotating the key.**
//   bun run scripts/generate-release-key.ts
// will overwrite the constant below with a freshly generated PEM and
// print the matching private key once for the operator to paste into
// the GitHub secret. See `docs/08-operations.md` for the rotation
// procedure (transitional release containing the new public key signed
// by the old key, then flip).
//
// The constant is exported as a string in PEM SubjectPublicKeyInfo
// (SPKI) format, the shape `crypto.createPublicKey()` accepts directly.

export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyF3lL39nLly5M13CruFCrfZJfJiCcvlyJi/ZeTIhe/U=
-----END PUBLIC KEY-----`;
