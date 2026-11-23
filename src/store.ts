/**
 * Storage contract for approval credentials.
 *
 * The security model only requires three operations. Any database can
 * implement them — Prisma, Drizzle, raw SQL, Redis with TTL, even SQLite.
 * The one non-negotiable is `tryConsume`: it must be an atomic
 * compare-and-set ("mark consumed only if still unconsumed") so that two
 * concurrent confirmations cannot both succeed.
 */
import type { PendingToolCallRecord } from "./core.js"

export interface IssuePendingCallInput {
  conversationId: string
  toolCallId: string
  toolName: string
  argsHash: string
  /** Sealed canonical args, if the caller encrypts them for preview/audit. */
  sealedArgs?: string | null
  ownerId: string
  scopeId?: string | null
  /** Credential lifetime from issuance. */
  ttlMs: number
  /** Injection point for tests/clocks. */
  now?: Date
}

export interface PendingCallStore {
  /** Fetch by the (conversationId, toolCallId) correlation key. */
  find(conversationId: string, toolCallId: string): Promise<PendingToolCallRecord | null>

  /**
   * Upsert semantics keyed on (conversationId, toolCallId): issuing again
   * for the same pair refreshes the credential (new hash, new expiry).
   */
  upsert(input: IssuePendingCallInput): Promise<PendingToolCallRecord>

  /**
   * Atomically mark the credential consumed iff `consumedAt` is still null.
   * Returns true exactly once per credential — the replay gate.
   */
  tryConsume(id: string, consumedAt?: Date): Promise<boolean>
}
