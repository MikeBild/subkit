export type ReceiptKey = "receipt.you_said" | "receipt.your_rule";

export const RECEIPT_COPY: Readonly<Record<"en" | "de", Readonly<Record<ReceiptKey, string>>>> = {
  en: {
    "receipt.you_said": "You said: “{quote}”",
    "receipt.your_rule": "Your rule, in your words: “{quote}”",
  },
  de: {
    "receipt.you_said": "Du hast gesagt: „{quote}“",
    "receipt.your_rule": "Deine Regel, in deinen Worten: „{quote}“",
  },
};

export function receiptLine(key: ReceiptKey, quote: string, locale: "en" | "de" = "en"): string {
  return RECEIPT_COPY[locale][key].replace("{quote}", () => quote);
}
