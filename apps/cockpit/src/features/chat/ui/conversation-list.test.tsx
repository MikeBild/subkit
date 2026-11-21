import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { ConversationList } from "./conversation-list";

const value = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
} as I18nValue;

function render(hasHidden: boolean, showHidden = false) {
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <ConversationList
        conversations={[]}
        activeId={null}
        onSelect={() => {}}
        showHidden={showHidden}
        hasHidden={hasHidden}
        onToggleHidden={() => {}}
        labelsFor={() => ({ untitled: "Ohne Titel", excerpt: null })}
      />
    </I18nContext.Provider>,
  );
}

describe("hidden conversations", () => {
  test("does not offer a hidden list when none exists", () => {
    expect(render(false)).not.toContain('data-testid="conversation-toggle-hidden"');
  });

  test("offers the hidden list when it contains conversations", () => {
    expect(render(true)).toContain('data-testid="conversation-toggle-hidden"');
    expect(render(true)).toContain(translate("de", "chat.hidden.show"));
  });

  test("keeps a way back after the last hidden conversation is removed", () => {
    const html = render(false, true);
    expect(html).toContain('data-testid="conversation-hidden-empty"');
    expect(html).toContain(translate("de", "chat.hidden.back"));
  });
});
