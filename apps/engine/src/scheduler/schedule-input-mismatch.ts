export interface ScheduleInputMismatch {
  checked_version_id: string;
  issues: { path: string; message: string }[];
}

export interface ScheduleInputVersions {
  active_version: number | null;
  prepared: { id: string; version: number } | null;
}

const MAX_NAMED_ISSUES = 5;

export function scheduleInputMismatchError(
  mismatch: ScheduleInputMismatch,
  versions: ScheduleInputVersions,
  kept_existing_input: boolean,
): Error {
  const { active_version, prepared } = versions;
  const named = mismatch.issues
    .slice(0, MAX_NAMED_ISSUES)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  const parts = [
    `schedule input does not match the active workflow${active_version === null ? "" : ` (version ${active_version})`}: ${named}`,
    ...(kept_existing_input
      ? ["the input was kept from the existing schedule; pass `input` to replace it"]
      : []),
    ...(prepared
      ? [
          `the input matches the prepared version ${prepared.version}, which is not active yet; activate it first, then schedule it`,
        ]
      : []),
  ];
  return Object.assign(new Error(parts.join("; ")), {
    code: "input_schema_violation",
    details: {
      ...mismatch,
      ...(active_version === null ? {} : { checked_version: active_version }),
      ...(kept_existing_input ? { kept_existing_input: true } : {}),
      ...(prepared ? { prepared_version_id: prepared.id, prepared_version: prepared.version } : {}),
    },
  });
}
