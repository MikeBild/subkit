import { decryptSecret, type EncryptedPayload, encryptSecret } from "../crypto/index.ts";

export interface NoteOwnerScope {
  readonly tenant_id: string;
  readonly user_id: string;
}

export type SealedField = "text" | "abstract" | "quote";

function aad(owner: NoteOwnerScope, note_id: string, field: SealedField): string {
  return JSON.stringify([owner.tenant_id, owner.user_id, note_id, field]);
}

export function sealField(
  owner: NoteOwnerScope,
  note_id: string,
  field: SealedField,
  plaintext: string,
): EncryptedPayload {
  return encryptSecret(plaintext, aad(owner, note_id, field));
}

export function openField(
  owner: NoteOwnerScope,
  note_id: string,
  field: SealedField,
  payload: EncryptedPayload,
): string {
  return decryptSecret(payload, aad(owner, note_id, field));
}
