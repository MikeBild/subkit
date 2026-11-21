export const THEME_COOKIE = "sk_theme";
export const LOCALE_COOKIE = "sk_locale";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function preferenceCookie(name: string, value: string | null, secure: boolean): string {
  const tail = `; SameSite=Lax${secure ? "; Secure" : ""}`;
  return value === null
    ? `${name}=; Path=/; Max-Age=0${tail}`
    : `${name}=${value}; Path=/; Max-Age=${MAX_AGE_SECONDS}${tail}`;
}

export function sharePreference(name: string, value: string | null): void {
  try {
    document.cookie = preferenceCookie(name, value, window.location.protocol === "https:");
  } catch {}
}
