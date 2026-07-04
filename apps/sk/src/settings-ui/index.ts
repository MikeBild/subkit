// Public surface for `sk settings configure`.
//
// `runSettingsApp` mounts the Ink modal against the engine, blocks until
// the operator exits (Esc / q / Ctrl-C), and resolves with the exit
// code (0 = success, 1 = failed to load).
//
// Implementation lives in SettingsApp.tsx + SettingsModal.tsx + the
// components/ folder. The shape consumed here is identical to the
// engine's GET /v1/settings response, so any leaf the schema declares
// is editable from the form without a CLI-side type table.

export { runSettingsApp, type SettingsAppOptions } from "./SettingsApp.tsx";
