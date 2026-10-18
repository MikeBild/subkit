import type { EngineClient } from "../engine-client.ts";

const ESCAPE = String.fromCharCode(27);
const OSC_ESCAPE = new RegExp(`${ESCAPE}\\][\\s\\S]*?(?:\\x07|${ESCAPE}\\\\)`, "g");
const CSI_ESCAPE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const CONTROL_CHARACTER = new RegExp(`[${String.raw`\u0000-\u001F\u007F`}]`, "g");

const AWAITING_REVIEW = ["collected", "reviewing"] as const;

export interface PendingIntake {
  category: string;
  count: number;
}

export function terminalText(value: string): string {
  return value.replace(OSC_ESCAPE, "").replace(CSI_ESCAPE, "").replace(CONTROL_CHARACTER, " ");
}

export function intakeReviewPrompt(category: string): string {
  return `Review my new items in “${terminalText(category)}”. Which ones help us? Suggest what we should retain, as knowledge or as a skill, with the exact text, sources and destination for my confirmation.`;
}

export function cockpitUrl(client: Pick<EngineClient, "base">, path: string): string {
  const url = new URL(client.base);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/cockpit/${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function cockpitIntakeUrl(client: Pick<EngineClient, "base">): string {
  return cockpitUrl(client, "intake");
}

export async function fetchPendingIntake(
  client: Pick<EngineClient, "getDefaultIntakeCategory" | "listIntakeItems">,
): Promise<PendingIntake | null> {
  try {
    const { category } = await client.getDefaultIntakeCategory();
    if (!category) return null;
    const pages = await Promise.all(
      AWAITING_REVIEW.map((state) => client.listIntakeItems({ category, state })),
    );
    return {
      category,
      count: pages.reduce((sum, page) => sum + (page.total ?? page.items.length), 0),
    };
  } catch {
    return null;
  }
}
