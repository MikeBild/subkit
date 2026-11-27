export type RegistrationAuthMethod = "none" | "client_secret_post";

export function registrationAuthMethod(
  supported: readonly string[] | undefined,
): RegistrationAuthMethod {
  return supported?.includes("none") ? "none" : "client_secret_post";
}
