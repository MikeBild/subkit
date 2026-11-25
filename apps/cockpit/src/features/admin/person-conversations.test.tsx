import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import { PersonConversations } from "./person-conversations";

function markup(locale: "de" | "en") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  client.setQueryData(["conversations", "person", "miriam"], {
    items: [
      {
        id: "c-private",
        title: null,
        content_hidden: true,
        visibility: "private",
        updated_at: "2026-11-24T09:30:00Z",
      },
      {
        id: "c-team",
        title: "Q4 numbers",
        visibility: "team",
        updated_at: "2026-11-23T09:30:00Z",
      },
    ],
    total: 2,
  });
  try {
    return render(
      <QueryClientProvider client={client}>
        <PersonConversations personId="miriam" name="Miriam Schulz" />
      </QueryClientProvider>,
      locale,
    );
  } finally {
    client.clear();
  }
}

test("a foreign private conversation shows that it exists and can be deleted, not what it says", () => {
  const html = markup("de");
  expect(html).toContain('data-testid="people-conversation-c-private"');
  expect(html).toContain(translate("de", "chat.visibility.hiddenTitle"));
  expect(html).toContain('data-testid="people-conversation-delete-c-private"');
  expect(html).toContain("Q4 numbers");
  expect(html).toContain(translate("de", "people.conversations.help"));
  expect(markup("en")).toContain(translate("en", "chat.visibility.hiddenTitle"));
});
