// Test shim for the driver egress fetch seam — the ONLY sanctioned
// import path for `_setDriverFetchForTests` (see the `test_seams_gated`
// invariant). Use this to install egress tripwires or fakes that
// intercept exactly the engine's driver/credential egress, immune to
// (and not polluting) `globalThis.fetch`.

export { _setDriverFetchForTests as setDriverFetchForTests } from "../connectors/drivers/fetch-seam.ts";
