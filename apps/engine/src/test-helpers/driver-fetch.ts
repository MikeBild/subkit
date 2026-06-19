// Test shim for the driver egress fetch seam — the ONLY sanctioned
// import path for `_withDriverFetchForTests` (see the `test_seams_gated`
// invariant). Wrap the acting code in `withDriverFetchForTests(fake, body)`
// to install egress tripwires or fakes that intercept exactly the
// engine's driver/credential egress, immune to (and not polluting)
// `globalThis.fetch`.

export { _withDriverFetchForTests as withDriverFetchForTests } from "../connectors/drivers/fetch-seam.ts";
