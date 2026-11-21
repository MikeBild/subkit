export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local
    .split(/[._+\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}
