export function conversationLocale(
  cookieHeader: string | undefined,
  acceptLanguage: string | undefined,
): "de" | "en" {
  const cookie = cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("sk_locale="))
    ?.slice("sk_locale=".length);
  if (cookie === "de" || cookie === "en") return cookie;
  const ranges = (acceptLanguage?.split(",") ?? [])
    .map((range, index) => {
      const [rawLanguage, ...parameters] = range.trim().split(";");
      const quality = parameters
        .map((parameter) => /^\s*q\s*=\s*(.*?)\s*$/i.exec(parameter)?.[1])
        .find((value) => value !== undefined);
      const parsedQuality = quality === undefined ? 1 : Number(quality);
      return {
        language: rawLanguage?.toLowerCase(),
        quality: Number.isFinite(parsedQuality) ? parsedQuality : 0,
        index,
      };
    })
    .filter((range) => range.quality > 0 && range.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { language } of ranges) {
    if (language === "de" || language?.startsWith("de-")) return "de";
    if (language === "en" || language?.startsWith("en-")) return "en";
  }
  return "en";
}
