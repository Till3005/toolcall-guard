/**
 * High-level guard API: issue credentials when a model proposes a write,
 * consume them exactly once when a human confirms.
 *
 * The flow this enforces:
 *
 *   1. Model returns tool calls → guard.issue() persists one credential per
 *      write call, keyed by (conversationId, toolCallId), binding the exact
 *      arguments via argsHash.
 *   2. Human reviews and confirms → client posts {conversationId, toolCallId,
 *      toolName, args} → guard.consume() re-fetches the credential, verifies
 *      owner/tool/expiry/args-hash, and atomically marks it consumed before
 *      the tool executes.
 *
 * Because consumption is a single atomic store operation, replay and
 * concurrent double-confirm are impossible even under race conditions.
 */
import {
  hashArgs,
  verifyPendingCall,
  type ConfirmContext,
  type PendingCallRejection,
  type PendingCallVerdict,
  type PendingToolCallRecord,
} from "./core.js"
import type { PendingCallStore } from "./store.js"

/** Default credential lifetime: 10 minutes. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000

export interface IssueParams {
  conversationId: string
  toolCallId: string
  toolName: string
  args: unknown
  ownerId: string
  scopeId?: string | null
  /** Override DEFAULT_TTL_MS. */
  ttlMs?: number
  /** Sealed canonical args for later preview/audit (see crypto.ts). */
  sealedArgs?: string | null
  now?: Date
}

export interface ConsumeParams {
  conversationId: string
  toolCallId: string
  toolName: string
  args: unknown
  ownerId: string
  scopeId?: string | null
  now?: Date
}

export type ConsumeResult =
  | { ok: true; record: PendingToolCallRecord }
  | { ok: false; reason: PendingCallRejection | "not_found" }

export interface ToolCallGuard {
  issue(params: IssueParams): Promise<PendingToolCallRecord>
  /**
   * Verify + atomically consume in one call. Safe under concurrency:
   * `tryConsume` is the single-winner gate even if two callers both pass
   * verification.
   */
  consume(params: ConsumeParams): Promise<ConsumeResult>
  find(conversationId: string, toolCallId: string): Promise<PendingToolCallRecord | null>
}

export function createToolCallGuard(opts: {
  store: PendingCallStore
  ttlMs?: number
  now?: () => Date
}): ToolCallGuard {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const clock = opts.now ?? (() => new Date())

  return {
    async issue(params) {
      return opts.store.upsert({
        conversationId: params.conversationId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        argsHash: hashArgs(params.args ?? {}),
        sealedArgs: params.sealedArgs ?? null,
        ownerId: params.ownerId,
        scopeId: params.scopeId ?? null,
        ttlMs: params.ttlMs ?? ttlMs,
        now: params.now ?? clock(),
      })
    },

    async consume(params) {
      const record = await opts.store.find(params.conversationId, params.toolCallId)
      if (!record) return { ok: false, reason: "not_found" }

      const ctx: ConfirmContext = {
        toolName: params.toolName,
        ownerId: params.ownerId,
        scopeId: params.scopeId ?? null,
        argsHash: hashArgs(params.args ?? {}),
        now: params.now ?? clock(),
      }
      const verdict: PendingCallVerdict = verifyPendingCall(record, ctx)
      if (!verdict.ok) return { ok: false, reason: verdict.reason }

      // Atomic gate: exactly one concurrent consumer wins.
      const won = await opts.store.tryConsume(record.id, ctx.now ?? new Date())
      if (!won) return { ok: false, reason: "consumed" }
      return { ok: true, record: { ...record, consumedAt: ctx.now ?? new Date() } }
    },

    find: (conversationId, toolCallId) => opts.store.find(conversationId, toolCallId),
  }
}
