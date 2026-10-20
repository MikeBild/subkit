export function describeRunWorkflowError(error: unknown): {
  error_code: string;
  message: string;
  recommended_mode: "workflow" | "execution";
  recoverable: boolean;
} {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "sensitive_execution_unsupported") {
    return {
      error_code: code,
      message:
        "Sensitive workflows cannot run on conversation surfaces. Use an authenticated non-chat run through sk CLI or Cockpit, then read the sensitive result as the original caller. Keep execution_privacy=sensitive.",
      recommended_mode: "execution",
      recoverable: false,
    };
  }
  if (code === "workflow_version_invalid") {
    return {
      error_code: code,
      message: error instanceof Error ? error.message : String(error),
      recommended_mode: "workflow",
      recoverable: true,
    };
  }
  return {
    error_code: "run_failed",
    message: error instanceof Error ? error.message : String(error),
    recommended_mode: "execution",
    recoverable: true,
  };
}
