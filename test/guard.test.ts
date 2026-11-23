import { describe, it, expect } from "vitest"
import { createMemoryStore } from "../src/memory.js"
import { createToolCallGuard, DEFAULT_TTL_MS } from "../src/guard.js"
import { hashArgs } from "../src/core.js"

const base = {
  conversationId: "conv1",
  toolCallId: "call1",
  toolName: "createOrder",
  args: { name: "tour", amount: 100 },
  ownerId: "u1",
  scopeId: "t1",
}

describe("createMemoryStore", () => {
  it("upsert refreshes an existing credential keyed on (conversationId, toolCallId)", async () => {
    const store = createMemoryStore()
    const first = await store.upsert({
      ...base,
      argsHash: hashArgs(base.args),
      ttlMs: 1000,
      now: new Date("2026-01-01T00:00:00Z"),
    })
    const second = await store.upsert({
      ...base,
      argsHash: hashArgs({ name: "changed" }),
      ttlMs: 1000,
      now: new Date("2026-01-01T00:00:00Z"),
    })
    expect(second.id).toBe(first.id)
    expect(second.argsHash).toBe(hashArgs({ name: "changed" }))
    expect(store.all()).toHaveLength(1)
  })

  it("tryConsume succeeds exactly once per credential", async () => {
    const store = createMemoryStore()
    const rec = await store.upsert({
      ...base,
      argsHash: hashArgs(base.args),
      ttlMs: 1000,
    })
    expect(await store.tryConsume(rec.id)).toBe(true)
    expect(await store.tryConsume(rec.id)).toBe(false)
    // Concurrent callers: only one winner.
    const rec2 = await store.upsert({
      ...base,
      toolCallId: "call2",
      argsHash: hashArgs(base.args),
      ttlMs: 1000,
    })
    const results = await Promise.all([
      store.tryConsume(rec2.id),
      store.tryConsume(rec2.id),
      store.tryConsume(rec2.id),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe("createToolCallGuard", () => {
  it("issue → consume roundtrip succeeds", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    await guard.issue(base)
    const res = await guard.consume(base)
    expect(res.ok).toBe(true)
  })

  it("second consume of the same credential → consumed", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    await guard.issue(base)
    expect((await guard.consume(base)).ok).toBe(true)
    const replay = await guard.consume(base)
    expect(replay).toEqual({ ok: false, reason: "consumed" })
  })

  it("consume with swapped args → args_mismatch", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    await guard.issue(base)
    const res = await guard.consume({ ...base, args: { name: "tour", amount: 999 } })
    expect(res).toEqual({ ok: false, reason: "args_mismatch" })
  })

  it("consume by a different owner → owner_mismatch", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    await guard.issue(base)
    const res = await guard.consume({ ...base, ownerId: "u2" })
    expect(res).toEqual({ ok: false, reason: "owner_mismatch" })
  })

  it("consume without the issued scope → owner_mismatch", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    await guard.issue(base)
    const res = await guard.consume({ ...base, scopeId: null })
    expect(res).toEqual({ ok: false, reason: "owner_mismatch" })
  })

  it("consume an unknown credential → not_found", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    const res = await guard.consume(base)
    expect(res).toEqual({ ok: false, reason: "not_found" })
  })

  it("expired credential → expired", async () => {
    const store = createMemoryStore()
    const issueGuard = createToolCallGuard({
      store,
      now: () => new Date("2026-01-01T00:00:00Z"),
    })
    await issueGuard.issue({ ...base, ttlMs: 1000 })
    const consumeGuard = createToolCallGuard({
      store,
      now: () => new Date("2026-01-01T00:00:02Z"),
    })
    const res = await consumeGuard.consume(base)
    expect(res).toEqual({ ok: false, reason: "expired" })
  })

  it("default TTL is 10 minutes", async () => {
    expect(DEFAULT_TTL_MS).toBe(600_000)
    const store = createMemoryStore()
    const guard = createToolCallGuard({ store })
    const before = Date.now()
    await guard.issue(base)
    const rec = store.all()[0]
    expect(rec.expiresAt.getTime() - before).toBeGreaterThan(599_000)
    expect(rec.expiresAt.getTime() - before).toBeLessThanOrEqual(601_000)
  })

  it("key order in args does not affect consume", async () => {
    const guard = createToolCallGuard({ store: createMemoryStore() })
    await guard.issue({ ...base, args: { name: "tour", amount: 100, extra: { b: 1, a: 2 } } })
    const res = await guard.consume({
      ...base,
      args: { extra: { a: 2, b: 1 }, amount: 100, name: "tour" },
    })
    expect(res.ok).toBe(true)
  })
})
