/**
 * In-memory PendingCallStore — for tests, local development, and
 * single-process deployments. Not shared-state safe across processes.
 */
import { randomUUID } from "node:crypto"
import type { PendingToolCallRecord } from "./core.js"
import type { IssuePendingCallInput, PendingCallStore } from "./store.js"

interface StoredCall extends PendingToolCallRecord {
  createdAt: Date
}

export function createMemoryStore(): PendingCallStore & { all(): StoredCall[] } {
  const calls = new Map<string, StoredCall>()
  const key = (conversationId: string, toolCallId: string) => `${conversationId}${toolCallId}`

  return {
    async find(conversationId, toolCallId) {
      return calls.get(key(conversationId, toolCallId)) ?? null
    },

    async upsert(input: IssuePendingCallInput) {
      const now = input.now ?? new Date()
      const k = key(input.conversationId, input.toolCallId)
      const existing = calls.get(k)
      const record: StoredCall = {
        id: existing?.id ?? randomUUID(),
        conversationId: input.conversationId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        argsHash: input.argsHash,
        sealedArgs: input.sealedArgs ?? null,
        // Owner/scope/consumed are issuance-time bindings: a refresh updates
        // the proposal fields only, matching the Prisma adapter.
        ownerId: existing?.ownerId ?? input.ownerId,
        scopeId: existing?.scopeId ?? input.scopeId ?? null,
        expiresAt: new Date(now.getTime() + input.ttlMs),
        consumedAt: existing?.consumedAt ?? null,
        createdAt: existing?.createdAt ?? now,
      }
      calls.set(k, record)
      return record
    },

    async tryConsume(id, consumedAt = new Date()) {
      for (const record of calls.values()) {
        if (record.id === id && record.consumedAt === null) {
          record.consumedAt = consumedAt
          return true
        }
      }
      return false
    },

    all() {
      return [...calls.values()]
    },
  }
}
