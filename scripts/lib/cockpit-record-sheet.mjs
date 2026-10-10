import { translate } from "../../apps/cockpit/src/lib/i18n.ts";

const CLOSE_NAME = new RegExp(
  `^(?:${["de", "en"]
    .map((locale) => translate(locale, "common.close").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`,
);

export async function closeRecordSheet(sheet) {
  await sheet.getByRole("button", { name: CLOSE_NAME }).click();
  await sheet.waitFor({ state: "hidden" });
}
