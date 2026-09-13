// API Keys sub-tab — list with revoke (consent-gated). Issue + rotate
// are CLI-only because both produce a one-time secret that the existing
// `sk apikeys create` flow already handles end-to-end (clipboard write,
// terminal echo control). Surfacing the same flow inside Ink would
// duplicate that code path; defer until create-form refactor lands.

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
   * panel is up. Threaded up to AdminTab → AdminCommand so the
   * outer shell's Esc handler stays suppressed.
   */
  onInnerEscape?: (active: boolean) => void;
}

interface KeyRow {
  id: string;
  name: string;
  status: string;
  lastUsed: string | null;
}

function pickName(raw: Record<string, unknown>): string {
  for (const key of ["name", "label", "id"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "(unnamed)";
}

function pickStatus(raw: Record<string, unknown>): string {
  if (typeof raw.status === "string") return raw.status;
  if (raw.revoked_at) return "revoked";
  return "active";
}

function pickLastUsed(raw: Record<string, unknown>): string | null {
  const v = raw.last_used_at ?? raw.used_at;
  return typeof v === "string" ? v : null;
}

export const ApiKeysSubTab: React.FC<Props> = ({ client, onInnerEscape }) => {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listIdx, setListIdx] = useState(0);
  const [pendingRevoke, setPendingRevoke] = useState<KeyRow | null>(null);
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
      .listApiKeys()
      .then((res) => {
        if (cancelled) return;
        const next: KeyRow[] = res.items.map((it) => ({
          id: typeof it.id === "string" ? it.id : "(unknown)",
          name: pickName(it),
          status: pickStatus(it),
          lastUsed: pickLastUsed(it),
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
      await client.revokeApiKey(pendingRevoke.id);
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
      <Text bold>API keys</Text>
      <Text color="gray">↑/↓ navigate · c create · x revoke · r refresh</Text>
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {actionFlash ? <Text color="cyan">{actionFlash}</Text> : null}
        {!loading && !error && rows.length === 0 ? <Text color="gray">no api keys</Text> : null}
        {rows.map((r, i) => (
          <Box key={r.id}>
            <Text color={i === listIdx ? "cyan" : "white"}>{i === listIdx ? "› " : "  "}</Text>
            <Text>{r.name}</Text>
            <Text color={r.status === "active" ? "green" : "gray"}> [{r.status}]</Text>
            {r.lastUsed ? <Text color="gray"> · last used {r.lastUsed}</Text> : null}
          </Box>
        ))}
      </Box>
      {createOpen ? (
        <Box marginTop={1}>
          <AdminCreateForm
            title="Issue API key"
            fields={[
              { key: "owner_id", label: "Owner id", required: true, placeholder: "user uuid" },
              {
                key: "owner_kind",
                label: "Owner kind",
                required: true,
                placeholder: "user | system_account",
              },
              { key: "scopes", label: "Scopes (csv)", placeholder: "rbac:read,audit:read" },
              { key: "expires_at", label: "Expires at", placeholder: "2026-12-31T00:00:00Z" },
            ]}
            onSubmit={async (vals) => {
              const body: Record<string, unknown> = {
                owner_id: vals.owner_id,
                owner_kind: vals.owner_kind || "user",
              };
              if (vals.scopes?.trim()) {
                body.scopes = vals.scopes
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
              }
              if (vals.expires_at?.trim()) body.expires_at = vals.expires_at.trim();
              const issued = (await client.issueApiKey(body)) as {
                id: string;
                plaintext_token?: string;
                prefix?: string;
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
            New api key — copy it now. The engine never echoes the plaintext again.
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
                setActionFlash(`token copied to clipboard for api key ${issuedSecret.id}`);
              setIssuedSecret(null);
            }}
          />
        </Box>
      ) : null}
      {pendingRevoke ? (
        <Box marginTop={1}>
          <ConsentPrompt
            title={`Revoke api key "${pendingRevoke.name}"?`}
            body="The key cannot be used again. Existing tokens issued from it remain valid until expiry."
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
      const ok = osc52Copy(token);
      onAck(ok);
      return;
    }
    if (input === "n") {
      onAck(false);
      return;
    }
  });
  return null;
};
