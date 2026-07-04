// Portal Tokens sub-tab — list with revoke (consent-gated). Issue is
// CLI-only because the URL/QR-code flow is owned by `/session` (M12).

import { osc52Copy } from "@cli-core/clipboard.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../../engine-client.ts";
import { ConsentPrompt } from "../../../repl/components/ConsentPrompt.tsx";
import { AdminCreateForm } from "./AdminCreateForm.tsx";

interface Props {
  client: EngineClient;
  /**
   * Fired when this sub-tab owns Esc — true while a revoke
   * confirmation, the create form, or the "shown once" issued-secret
   * panel is up.
   */
  onInnerEscape?: (active: boolean) => void;
}

interface TokenRow {
  id: string;
  name: string;
  status: string;
  expiresAt: string | null;
}

function pickName(raw: Record<string, unknown>): string {
  for (const key of ["label", "name", "id"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "(unnamed)";
}

function pickStatus(raw: Record<string, unknown>): string {
  if (typeof raw.status === "string") return raw.status;
  if (raw.revoked_at) return "revoked";
  if (typeof raw.expires_at === "string") {
    return new Date(raw.expires_at).getTime() < Date.now() ? "expired" : "active";
  }
  return "active";
}

export const PortalTokensSubTab: React.FC<Props> = ({ client, onInnerEscape }) => {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listIdx, setListIdx] = useState(0);
  const [pendingRevoke, setPendingRevoke] = useState<TokenRow | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState<{ id: string; token: string } | null>(null);

  useEffect(() => {
    onInnerEscape?.(pendingRevoke !== null || createOpen || issuedSecret !== null);
  }, [pendingRevoke, createOpen, issuedSecret, onInnerEscape]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .listPortalTokens()
      .then((res) => {
        if (cancelled) return;
        const next: TokenRow[] = res.items.map((it) => ({
          id: typeof it.id === "string" ? it.id : "(unknown)",
          name: pickName(it),
          status: pickStatus(it),
          expiresAt: typeof it.expires_at === "string" ? it.expires_at : null,
        }));
        setRows(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  useInput((input, key) => {
    if (pendingRevoke || createOpen || issuedSecret) return;
    if (key.upArrow) {
      setListIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setListIdx((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (input === "x") {
      const sel = rows[listIdx];
      if (sel) setPendingRevoke(sel);
      return;
    }
    if (input === "r") {
      setRefreshKey((k) => k + 1);
      return;
    }
    if (input === "c") {
      setCreateOpen(true);
      return;
    }
  });

  const onConfirmRevoke = async (): Promise<void> => {
    if (!pendingRevoke) return;
    try {
      await client.revokePortalToken(pendingRevoke.id);
      setRows((prev) =>
        prev.map((r) => (r.id === pendingRevoke.id ? { ...r, status: "revoked" } : r)),
      );
      setActionFlash(`revoked ${pendingRevoke.name}`);
    } catch (err) {
      setActionFlash(`revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setPendingRevoke(null);
  };

  return (
    <Box flexDirection="column">
      <Text bold>Portal tokens</Text>
      <Text color="gray">/session for QR · ↑/↓ navigate · c create · x revoke · r refresh</Text>
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {actionFlash ? <Text color="cyan">{actionFlash}</Text> : null}
        {!loading && !error && rows.length === 0 ? (
          <Text color="gray">no portal tokens</Text>
        ) : null}
        {rows.map((r, i) => (
          <Box key={r.id}>
            <Text color={i === listIdx ? "cyan" : "white"}>{i === listIdx ? "› " : "  "}</Text>
            <Text>{r.name}</Text>
            <Text color={r.status === "active" ? "green" : "gray"}> [{r.status}]</Text>
            {r.expiresAt ? <Text color="gray"> · exp {r.expiresAt}</Text> : null}
          </Box>
        ))}
      </Box>
      {createOpen ? (
        <Box marginTop={1}>
          <AdminCreateForm
            title="Issue portal token"
            fields={[
              { key: "user_id", label: "User id", required: true, placeholder: "user uuid" },
              {
                key: "allowed_workflows",
                label: "Allowed workflows",
                required: true,
                placeholder: "csv of workflow ids",
              },
              { key: "ttl_minutes", label: "TTL minutes", placeholder: "15 (default)" },
            ]}
            onSubmit={async (vals) => {
              const body: Record<string, unknown> = {
                user_id: vals.user_id,
                allowed_workflows: (vals.allowed_workflows ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              };
              const ttl = Number.parseInt(vals.ttl_minutes ?? "", 10);
              if (Number.isInteger(ttl) && ttl > 0) body.ttl_minutes = ttl;
              const issued = (await client.issuePortalToken(body)) as {
                id: string;
                plaintext_token?: string;
                expires_at?: string;
              };
              setCreateOpen(false);
              setRefreshKey((k) => k + 1);
              if (issued.plaintext_token) {
                setIssuedSecret({ id: issued.id, token: issued.plaintext_token });
              } else {
                setActionFlash(`issued ${issued.id} — engine did not return plaintext_token`);
              }
            }}
            onCancel={() => setCreateOpen(false)}
          />
        </Box>
      ) : null}
      {issuedSecret ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="yellow">
            New portal token — copy it now. The engine never echoes the plaintext again.
          </Text>
          <Box marginTop={1}>
            <Text color="gray">id: </Text>
            <Text>{issuedSecret.id}</Text>
          </Box>
          <Box>
            <Text color="gray">token: </Text>
            <Text>{issuedSecret.token}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Press y to copy to clipboard · n to dismiss</Text>
          </Box>
          <SecretConfirm
            token={issuedSecret.token}
            onAck={(copied) => {
              if (copied)
                setActionFlash(`token copied to clipboard for portal token ${issuedSecret.id}`);
              setIssuedSecret(null);
            }}
          />
        </Box>
      ) : null}
      {pendingRevoke ? (
        <Box marginTop={1}>
          <ConsentPrompt
            title={`Revoke portal token "${pendingRevoke.name}"?`}
            body="The token cannot be used again. Active mobile/portal sessions using it will be disconnected."
            yesLabel="Revoke"
            noLabel="Cancel"
            onYes={onConfirmRevoke}
            onNo={() => setPendingRevoke(null)}
          />
        </Box>
      ) : null}
    </Box>
  );
};

const SecretConfirm: React.FC<{ token: string; onAck: (copied: boolean) => void }> = ({
  token,
  onAck,
}) => {
  useInput((input) => {
    if (input === "y") {
      onAck(osc52Copy(token));
      return;
    }
    if (input === "n") onAck(false);
  });
  return null;
};
