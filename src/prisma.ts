/**
 * Prisma adapter for PendingCallStore.
 *
 * Expects the consuming schema to define a `pendingToolCall` model — paste
 * schema.prisma (shipped with this package) into your Prisma schema, run
 * `prisma migrate`, and pass your PrismaClient (or a transaction client)
 * here. The adapter is duck-typed: any client exposing
 * `pendingToolCall.{findFirst,upsert,updateMany}` works, including
 * `$extends`-wrapped clients.
 */
import { randomUUID } from "node:crypto"
import type { PendingToolCallRecord } from "./core.js"
import type { IssuePendingCallInput, PendingCallStore } from "./store.js"

/** Minimal delegate shape the adapter needs — satisfied by PrismaClient. */
export interface PendingCallDelegate {
  findFirst(args: {
    where: { conversationId: string; toolCallId: string }
  }): Promise<PendingToolCallRecord | null>
  upsert(args: {
    where: { conversationId_toolCallId: { conversationId: string; toolCallId: string } }
    create: Record<string, unknown>
    update: Record<string, unknown>
  }): Promise<PendingToolCallRecord>
  updateMany(args: {
    where: { id: string; consumedAt: null }
    data: { consumedAt: Date }
  }): Promise<{ count: number }>
}

export interface PrismaLikeClient {
  pendingToolCall: PendingCallDelegate
}

interface PrismaRow {
  id: string
  conversationId: string
  toolCallId: string
  toolName: string
  argsHash: string
  sealedArgs?: string | null
  ownerId: string
  scopeId?: string | null
  expiresAt: Date
  consumedAt: Date | null
}

function toRecord(row: PrismaRow): PendingToolCallRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    argsHash: row.argsHash,
    sealedArgs: row.sealedArgs ?? null,
    ownerId: row.ownerId,
    scopeId: row.scopeId ?? null,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  }
}

export function createPrismaStore(client: PrismaLikeClient): PendingCallStore {
  return {
    async find(conversationId, toolCallId) {
      const row = await client.pendingToolCall.findFirst({
        where: { conversationId, toolCallId },
      })
      return row ? toRecord(row as PrismaRow) : null
    },

    async upsert(input: IssuePendingCallInput) {
      const now = input.now ?? new Date()
      const row = await client.pendingToolCall.upsert({
        where: {
          conversationId_toolCallId: {
            conversationId: input.conversationId,
            toolCallId: input.toolCallId,
          },
        },
        create: {
          id: randomUUID(),
          conversationId: input.conversationId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          argsHash: input.argsHash,
          sealedArgs: input.sealedArgs ?? null,
          ownerId: input.ownerId,
          scopeId: input.scopeId ?? null,
          expiresAt: new Date(now.getTime() + input.ttlMs),
          consumedAt: null,
        },
        // Re-issuing the same (conversationId, toolCallId) refreshes the
        // proposal fields and expiry only. ownerId/scopeId/consumedAt are
        // deliberately untouched: a consumed credential must never be
        // resurrected by a duplicate issuance (replay), and ownership
        // binding stays with the original issuer.
        update: {
          toolName: input.toolName,
          argsHash: input.argsHash,
          sealedArgs: input.sealedArgs ?? null,
          expiresAt: new Date(now.getTime() + input.ttlMs),
        },
      })
      return toRecord(row as PrismaRow)
    },

    async tryConsume(id, consumedAt = new Date()) {
      // Atomic compare-and-set: the WHERE consumedAt:null guard means exactly
      // one concurrent caller observes count===1.
      const res = await client.pendingToolCall.updateMany({
        where: { id, consumedAt: null },
        data: { consumedAt },
      })
      return res.count === 1
    },
  }
}
