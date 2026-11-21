import { PREFLIGHT_HELP } from "./preflight/index.ts";

export function engineHelp(version: string): string {
  return (
    `subkit engine ${version}\n\n` +
    "Usage: engine [flags]\n\n" +
    "Flags:\n" +
    "  --version          print the engine version and exit\n" +
    "  --help             print this help and exit\n" +
    "  --smoke            validate logger/audit/redaction and exit\n" +
    "  --migrate          run pending database migrations and exit\n" +
    "  --seed             seed the database and exit\n" +
    "  --check-update     check for a newer binary and exit\n" +
    "  --self-update      download + install a newer binary and exit\n" +
    "  --rollback         roll back to the previous binary and exit\n" +
    "    --to=<version>            roll back to a specific retained version\n" +
    "  --issue-admin-key  issue an admin API key and exit\n" +
    "    --tenant <slug>           tenant to mint the key against\n" +
    "  --set-operator-tenant <slug>\n" +
    "                     make this workspace the engine operator (moves the flag) and exit\n" +
    "  --token-exchange   swap an API key for a short-lived Bearer token and exit\n" +
    "    --key-file <path>         file holding the key (never pass the key as an argument)\n" +
    "    --scope <scopes>          narrow to a subset of the key's scopes (space-separated;\n" +
    "                              workflow:<id> narrows the workflows); default: the key's\n" +
    "    --ttl <seconds>           lifetime, 1..3600; default 900\n" +
    "    Prints the token on stdout, so a script does\n" +
    "      TOKEN=$(engine --token-exchange --key-file /etc/subkit/api-key)\n" +
    '      curl -H "Authorization: Bearer $TOKEN" https://<host>/metrics\n' +
    "    Same as POST /v1/oauth/token with grant_type=urn:ietf:params:oauth:grant-type:token-exchange.\n" +
    PREFLIGHT_HELP
  );
}
