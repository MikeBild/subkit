import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { ApiKeysSubTab } from "./admin/ApiKeysSubTab.tsx";
import { GenericListSubTab } from "./admin/GenericListSubTab.tsx";
import { PortalTokensSubTab } from "./admin/PortalTokensSubTab.tsx";

interface Props {
  client: EngineClient;
  onInnerEscape?: (active: boolean) => void;
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

export const AdminTab: React.FC<Props> = ({ client, onInnerEscape }) => {
  const [idx, setIdx] = useState(0);
  const [subInner, setSubInner] = useState(false);

  useEffect(() => {
    onInnerEscape?.(subInner);
  }, [subInner, onInnerEscape]);

  useEffect(() => {
    setSubInner(false);
  }, []);

  useInput((input) => {
    const n = Number.parseInt(input, 10);
    if (Number.isInteger(n) && n >= 1 && n <= SUB_TABS.length) {
      setIdx(n - 1);
      setSubInner(false);
    }
  });

  const active = SUB_TABS[idx] ?? "RBAC";

  const subTabBody = (() => {
    switch (active) {
      case "API Keys":
        return <ApiKeysSubTab client={client} onInnerEscape={setSubInner} />;
      case "Portal Tokens":
        return <PortalTokensSubTab client={client} onInnerEscape={setSubInner} />;
      case "RBAC":
        return (
          <GenericListSubTab
            onInnerEscape={setSubInner}
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
            onInnerEscape={setSubInner}
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
            onInnerEscape={setSubInner}
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
            onInnerEscape={setSubInner}
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
            onInnerEscape={setSubInner}
            title="Notification channels"
            fetcher={() => client.listNotificationChannels()}
            createForm={{
              title: "Create notification channel",
              fields: [
                {
                  key: "platform",
                  label: "Platform",
                  required: true,
                  placeholder: "slack | teams | google_chat",
                },
                {
                  key: "workspace_id",
                  label: "Workspace id",
                  required: true,
                  placeholder: "T0123456",
                },
                {
                  key: "channel_id",
                  label: "Channel id",
                  required: true,
                  placeholder: "C0123456",
                },
              ],
              submit: async (vals) => {
                await client.createNotificationChannel({
                  platform: vals.platform,
                  workspace_id: vals.workspace_id,
                  channel_id: vals.channel_id,
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
