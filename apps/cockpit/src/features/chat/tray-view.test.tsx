import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import type { TrayChip, TrayProblem } from "./tray-model";
import { ComposerTrayChips, ComposerTrayNotice } from "./tray-view";

const AT = Date.parse("2026-11-21T12:00:00Z");

const chips: TrayChip[] = [
  {
    id: "a",
    fileId: "fid_a",
    name: "Angebot.pdf",
    size: 1_500_000,
    kind: "pdf",
    contentType: null,
  },
  { id: "b", fileId: "fid_b", name: "notes.md", size: 4000, kind: "md", contentType: null },
];

test("tray files appear as attachment chips with size and a remove button", () => {
  const html = render(<ComposerTrayChips chips={chips} onOpen={() => {}} onRemove={() => {}} />);
  expect(html).toContain('data-testid="chat-tray-0"');
  expect(html).toContain('data-testid="chat-tray-1-remove"');
  expect(html).toContain("Angebot.pdf · 1,5 MB");
  expect(html).toContain("notes.md · 4 KB");
  expect(html).toContain("Angebot.pdf entfernen");
});

test("an expired file is named once in a warning without a remove action", () => {
  const problems: TrayProblem[] = [{ id: "a", name: "Angebot.pdf", reason: "expired" }];
  const html = render(
    <ComposerTrayNotice problems={problems} onRemove={() => {}} onDismiss={() => {}} at={AT} />,
  );
  expect(html).toContain('data-testid="chat-tray-notice"');
  expect(html).toContain("Nicht angehängt");
  expect(html).toContain("Angebot.pdf · nach 24 Std. abgelaufen");
  expect(html).toContain("bg-amber-500");
  expect(html).toContain('data-testid="chat-tray-notice-dismiss"');
  expect(html).not.toContain("chat-tray-notice-remove");
});

test("a failed scan offers to remove the file", () => {
  const problems: TrayProblem[] = [
    { id: "a", name: "a.pdf", reason: "expired" },
    { id: "b", name: "b.png", reason: "scan_failed" },
  ];
  const html = render(
    <ComposerTrayNotice problems={problems} onRemove={() => {}} onDismiss={() => {}} at={AT} />,
    "en",
  );
  expect(html).toContain("Not attached");
  expect(html).toContain("b.png · failed the security scan");
  expect(html).toContain("bg-destructive");
  expect(html).toContain('data-testid="chat-tray-notice-remove"');
});

test("no problems render nothing", () => {
  expect(
    render(<ComposerTrayNotice problems={[]} onRemove={() => {}} onDismiss={() => {}} at={AT} />),
  ).toBe("");
});
