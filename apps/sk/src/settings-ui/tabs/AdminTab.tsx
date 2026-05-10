// Admin tab — role-gated landing pad with seven sub-tabs over admin
// resources. The outer 10-tab shell hides this tab unless the principal
// holds at least one admin-scoped permission; server-side RBAC enforces
// every mutation independently.
//
// Sub-tabs render list views via existing engine endpoints. Where the
// engine supports a single-shot mutation (revoke API key, revoke portal
// token) it is wired here behind a ConsentPrompt; create/edit forms
// remain CLI-only (`sk apikeys create`, `sk rbac role create`, …).
// The sub-tab carries an explicit CLI hint to make the deviation visible.
//
// Press 1–7 to jump to a sub-tab directly. Esc cascades to the outer
// modal once any inner search input is empty.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { ApiKeysSubTab } from "./admin/ApiKeysSubTab.tsx";
import { GenericListSubTab } from "./admin/GenericListSubTab.tsx";
import { PortalTokensSubTab } from "./admin/PortalTokensSubTab.tsx";

interface Props {
  client: EngineClient;
}

type SubTabName =
  | "RBAC"
  | "Subscriptions"
  | "API Keys"
  | "System Accounts"
  | "Hooks"
  | "Notifications"
  | "Portal Tokens";

const SUB_TABS: SubTabName[] = [
  "RBAC",
  "Subscriptions",
  "API Keys",
  "System Accounts",
  "Hooks",
  "Notifications",
  "Portal Tokens",
];

export const AdminTab: React.FC<Props> = ({ client }) => {
  const [idx, setIdx] = useState(0);

  useInput((input) => {
    const n = Number.parseInt(input, 10);
    if (Number.isInteger(n) && n >= 1 && n <= SUB_TABS.length) {
      setIdx(n - 1);
    }
  });

  const active = SUB_TABS[idx] ?? "RBAC";

  const subTabBody = (() => {
    switch (active) {
      case "API Keys":
        return <ApiKeysSubTab client={client} />;
      case "Portal Tokens":
        return <PortalTokensSubTab client={client} />;
      case "RBAC":
        return (
          <GenericListSubTab
            title="Roles"
            fetcher={() => client.listRoles({})}
            createForm={{
              title: "Create role",
              fields: [
                { key: "name", label: "Name", required: true, placeholder: "ops-readonly" },
                {
                  key: "description",
                  label: "Description",
                  placeholder: "(optional, free-form)",
                },
              ],
              submit: async (vals) => {
                const body: Record<string, unknown> = { name: vals.name };
                if (vals.description?.trim()) body.description = vals.description.trim();
                await client.createRole(body);
              },
            }}
          />
        );
      case "Subscriptions":
        return (
          <GenericListSubTab
            title="Subscriptions"
            fetcher={() => client.listSubscriptions()}
            createForm={{
              title: "Create subscription",
              fields: [
                {
                  key: "topic",
                  label: "Topic",
                  required: true,
                  placeholder: "execution.completed",
                },
                {
                  key: "endpoint",
                  label: "Endpoint URL",
                  required: true,
                  placeholder: "https://…",
                },
                { key: "secret", label: "HMAC secret", placeholder: "(optional)" },
              ],
              submit: async (vals) => {
                const body: Record<string, unknown> = {
                  topic: vals.topic,
                  endpoint: vals.endpoint,
                };
                if (vals.secret?.trim()) body.secret = vals.secret.trim();
                await client.createSubscription(body);
              },
            }}
          />
        );
      case "System Accounts":
        return (
          <GenericListSubTab
            title="System accounts"
            fetcher={() => client.listSystemAccounts()}
            createForm={{
              title: "Create system account",
              fields: [
                { key: "name", label: "Name", required: true, placeholder: "ci-deployer" },
                { key: "role_id", label: "Role id", placeholder: "(optional uuid)" },
              ],
              submit: async (vals) => {
                const body: Record<string, unknown> = { name: vals.name };
                if (vals.role_id?.trim()) body.role_id = vals.role_id.trim();
                await client.createSystemAccount(body);
              },
            }}
          />
        );
      case "Hooks":
        return (
          <GenericListSubTab
            title="Hooks (inbound)"
            fetcher={() => client.listHooksInbound()}
            createForm={{
              title: "Create inbound hook",
              fields: [
                { key: "slug", label: "Slug", required: true, placeholder: "stripe-webhook" },
                { key: "secret", label: "HMAC secret", placeholder: "(optional)" },
              ],
              submit: async (vals) => {
                const body: Record<string, unknown> = { slug: vals.slug };
                if (vals.secret?.trim()) body.secret = vals.secret.trim();
                await client.createHookInbound(body);
              },
            }}
          />
        );
      case "Notifications":
        return (
          <GenericListSubTab
            title="Notification channels"
            fetcher={() => client.listNotificationChannels()}
            createForm={{
              title: "Create notification channel",
              fields: [
                {
                  key: "kind",
                  label: "Kind",
                  required: true,
                  placeholder: "slack | teams | email | webhook",
                },
                {
                  key: "name",
                  label: "Name",
                  required: true,
                  placeholder: "ops-alerts",
                },
                {
                  key: "target",
                  label: "Target",
                  required: true,
                  placeholder: "channel/url/email",
                },
              ],
              submit: async (vals) => {
                await client.createNotificationChannel({
                  kind: vals.kind,
                  name: vals.name,
                  target: vals.target,
                });
              },
            }}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <Box flexDirection="column">
      <Text bold>Admin</Text>
      <Box>
        <Text color="gray">Press 1–7 to switch sub-tabs · Esc returns to the outer modal</Text>
      </Box>
      <Box marginTop={1}>
        {SUB_TABS.map((t, i) => (
          <Text
            key={t}
            color={i === idx ? "cyan" : "gray"}
            bold={i === idx}
          >{`${i + 1}.${t}${i === SUB_TABS.length - 1 ? "" : "  "}`}</Text>
        ))}
      </Box>
      <Box marginTop={1}>{subTabBody}</Box>
    </Box>
  );
};
