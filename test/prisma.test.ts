import { describe, it, expect } from "vitest"
import { createPrismaStore, type PrismaLikeClient } from "../src/prisma.js"
import { hashArgs } from "../src/core.js"
import type { PendingToolCallRecord } from "../src/core.js"

/**
 * Fake Prisma delegate backed by a Map — exercises the adapter's query
 * shapes and atomic-consume semantics without a real database.
 */
function fakeClient() {
  const rows = new Map<string, PendingToolCallRecord & { sealedArgs: string | null }>()
  const client: PrismaLikeClient = {
    pendingToolCall: {
      async findFirst({ where }) {
        for (const r of rows.values()) {
          if (r.conversationId === where.conversationId && r.toolCallId === where.toolCallId) {
            return r
          }
        }
        return null
      },
      async upsert({ where, create, update }) {
        const { conversationId, toolCallId } = where.conversationId_toolCallId
        const key = `${conversationId}${toolCallId}`
        const existing = rows.get(key)
        const base = existing ?? ({ ...create } as PendingToolCallRecord & { sealedArgs: string | null })
        const merged = { ...base, ...update, id: base.id } as PendingToolCallRecord & {
          sealedArgs: string | null
        }
        // upsert create path needs the full record; update path merges.
        if (!existing) {
          rows.set(key, merged)
        } else {
          rows.set(key, { ...existing, ...update } as typeof merged)
        }
        return rows.get(key)!
      },
      async updateMany({ where, data }) {
        const row = [...rows.values()].find((r) => r.id === where.id)
        if (!row || row.consumedAt !== null) return { count: 0 }
        row.consumedAt = data.consumedAt
        return { count: 1 }
      },
    },
  }
  return { client, rows }
}

const input = {
  conversationId: "conv1",
  toolCallId: "call1",
  toolName: "createOrder",
  argsHash: hashArgs({ a: 1 }),
  ownerId: "u1",
  scopeId: "t1",
  ttlMs: 60_000,
  now: new Date("2026-01-01T00:00:00Z"),
}

describe("createPrismaStore", () => {
  it("upsert creates then refreshes the same row", async () => {
    const { client, rows } = fakeClient()
    const store = createPrismaStore(client)
    const first = await store.upsert(input)
    const second = await store.upsert({ ...input, argsHash: hashArgs({ a: 2 }) })
    expect(second.id).toBe(first.id)
    expect(second.argsHash).toBe(hashArgs({ a: 2 }))
    expect(rows.size).toBe(1)
  })

  it("find returns the credential by correlation key", async () => {
    const { client } = fakeClient()
    const store = createPrismaStore(client)
    await store.upsert(input)
    const found = await store.find("conv1", "call1")
    expect(found?.toolName).toBe("createOrder")
    expect(found?.expiresAt.toISOString()).toBe("2026-01-01T00:01:00.000Z")
    expect(await store.find("conv1", "nope")).toBeNull()
  })

  it("tryConsume flips consumedAt exactly once", async () => {
    const { client } = fakeClient()
    const store = createPrismaStore(client)
    const rec = await store.upsert(input)
    expect(await store.tryConsume(rec.id)).toBe(true)
    expect(await store.tryConsume(rec.id)).toBe(false)
    const after = await store.find("conv1", "call1")
    expect(after?.consumedAt).not.toBeNull()
  })
})
