// `/install-*` slashes redirect to the out-of-REPL `sk install <kind>`
// CLI command. Each is a one-line banner; bundling them into a small
// table keeps the per-banner copy out of the main dispatcher.
// Extracted from `handler.ts` (R7-S2 review fix).
//
// Returns:
//   - `string` if the command was handled (banner)
//   - `undefined` if the name doesn't belong to this group; main
//     dispatcher should fall through.

const INSTALL_BANNERS: Readonly<Record<string, string>> = Object.freeze({
  "install-slack": "run 'sk install slack' outside the REPL to set up Slack notifications",
  "install-teams":
    "run 'sk install teams' outside the REPL to set up Microsoft Teams notifications",
  "install-github": "run 'sk install github' outside the REPL to connect GitHub",
  "install-google-workspace":
    "run 'sk install google-workspace' outside the REPL to connect Google Workspace",
  "install-salesforce": "run 'sk install salesforce' outside the REPL to connect Salesforce",
  "install-jira": "run 'sk install jira' outside the REPL to connect Jira",
  "install-hubspot": "run 'sk install hubspot' outside the REPL to connect HubSpot",
});

export function dispatchInstallWizardSlash(name: string): string | undefined {
  return INSTALL_BANNERS[name];
}
