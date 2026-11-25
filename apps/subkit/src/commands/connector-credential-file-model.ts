import type { CredentialBody } from "../engine-client/connectors.ts";

type CredentialMode = CredentialBody["mode"];
type FieldKind = "string" | "optional_string" | "record";

export const CREDENTIAL_MODE_FIELDS: Readonly<
  Record<CredentialMode, Readonly<Record<string, FieldKind>>>
> = {
  none: {},
  header: { headers: "record" },
  query: { query: "record" },
  bearer: { token: "string" },
  basic: { username: "string", password: "optional_string" },
  aws_sigv4: { access_key_id: "string", secret_access_key: "string" },
  signed_jwt: { private_key: "string" },
  connection: { connection_id: "string" },
};

const CREDENTIAL_MODES = Object.keys(CREDENTIAL_MODE_FIELDS) as CredentialMode[];
const CREDENTIAL_EXAMPLE = '{"mode":"bearer","token":"…"}';

const modeShape = (mode: CredentialMode): string => {
  const fields = Object.keys(CREDENTIAL_MODE_FIELDS[mode]);
  const required = fields.length > 0 ? fields.join("+") : "no fields";
  return mode === "aws_sigv4" ? `${mode}→${required}[+session_token]` : `${mode}→${required}`;
};

export const CREDENTIAL_SHAPE_HELP = `JSON object with a \`mode\` and the fields it needs: ${CREDENTIAL_MODES.filter(
  (mode) => mode !== "connection",
)
  .map(modeShape)
  .join(", ")}. Example: ${CREDENTIAL_EXAMPLE}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fieldPresent = (kind: FieldKind, value: unknown): boolean =>
  kind === "record"
    ? isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
    : kind === "optional_string"
      ? typeof value === "string"
      : typeof value === "string" && value.length > 0;

const isCredentialMode = (value: unknown): value is CredentialMode =>
  typeof value === "string" && (CREDENTIAL_MODES as string[]).includes(value);

export function parseCredentialFile(raw: unknown): CredentialBody {
  if (!isRecord(raw)) {
    throw new Error(`credential file: must be a JSON object, e.g. ${CREDENTIAL_EXAMPLE}`);
  }
  const modeList = CREDENTIAL_MODES.join("|");
  if (raw.mode === undefined) {
    throw new Error(
      `credential file: field \`mode\` is required (one of ${modeList}), e.g. ${CREDENTIAL_EXAMPLE}`,
    );
  }
  if (!isCredentialMode(raw.mode)) {
    throw new Error(
      `credential file: field \`mode\` must be one of ${modeList}, got ${JSON.stringify(raw.mode)}`,
    );
  }
  const mode = raw.mode;
  const missing = Object.entries(CREDENTIAL_MODE_FIELDS[mode])
    .filter(([field, kind]) => !fieldPresent(kind, raw[field]))
    .map(([field]) => `\`${field}\``);
  if (missing.length > 0) {
    throw new Error(`credential file: mode ${mode} requires ${missing.join(" and ")}`);
  }
  return raw as CredentialBody;
}

export const CREDENTIAL_MISSING_HINT = `needs a credential — pass --credential <file> (e.g. ${CREDENTIAL_EXAMPLE}) or attach one later with \`subkit vault attach\``;

export function credentialHint(result: {
  error_code?: string | undefined;
  detail?: string | undefined;
}): string | undefined {
  return result.error_code === "credential_missing"
    ? CREDENTIAL_MISSING_HINT
    : (result.detail ?? undefined);
}
