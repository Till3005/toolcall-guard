import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import {
  canonicalArgsJson,
  hashArgs,
  verifyPendingCall,
  isPendingCallExpired,
  isPendingCallConsumed,
  extractWriteToolCalls,
  argsPreviewFromCanonical,
  type PendingToolCallRecord,
} from "../src/index.js"

describe("canonicalArgsJson / hashArgs — key-order-independent hashing", () => {
  it("same args in different key order → identical JSON and hash", () => {
    const a = { name: "tour", days: 3, type: "group" }
    const b = { type: "group", name: "tour", days: 3 }
    expect(canonicalArgsJson(a)).toBe(canonicalArgsJson(b))
    expect(hashArgs(a)).toBe(hashArgs(b))
  })

  it("nested object key order is normalized (deep sort)", () => {
    const a = { meta: { z: 1, a: 2 }, name: "x" }
    const b = { name: "x", meta: { a: 2, z: 1 } }
    expect(hashArgs(a)).toBe(hashArgs(b))
  })

  it("arrays keep their order (order is semantic)", () => {
    expect(hashArgs({ ids: [1, 2, 3] })).not.toBe(hashArgs({ ids: [3, 2, 1] }))
  })

  it("any field change → different hash", () => {
    expect(hashArgs({ name: "A" })).not.toBe(hashArgs({ name: "B" }))
    expect(hashArgs({ amount: 100 })).not.toBe(hashArgs({ amount: 101 }))
  })

  it("undefined normalizes to null; empty object is stable", () => {
    expect(hashArgs(undefined)).toBe(hashArgs(null))
    expect(hashArgs({ a: undefined })).toBe(hashArgs({ a: null }))
    expect(canonicalArgsJson({})).toBe("{}")
  })

  it("hash is 64-char hex (sha256)", () => {
    expect(hashArgs({ name: "x" })).toMatch(/^[0-9a-f]{64}$/)
  })
})

const baseRecord = (over: Partial<PendingToolCallRecord> = {}): PendingToolCallRecord => ({
  id: "rec1",
  conversationId: "conv1",
  toolCallId: "call1",
  toolName: "createOrder",
  argsHash: hashArgs({ name: "tour" }),
  ownerId: "u1",
  scopeId: "t1",
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  ...over,
})

const ctx = (over: Partial<Parameters<typeof verifyPendingCall>[1]> = {}) => ({
  toolName: "createOrder",
  ownerId: "u1",
  scopeId: "t1",
  argsHash: hashArgs({ name: "tour" }),
  ...over,
})

describe("isPendingCallExpired / isPendingCallConsumed", () => {
  it("expiresAt <= now → expired", () => {
    expect(isPendingCallExpired({ expiresAt: new Date(Date.now() - 1) })).toBe(true)
    expect(isPendingCallExpired({ expiresAt: new Date(Date.now() + 60_000) })).toBe(false)
  })
  it("consumedAt non-null → consumed", () => {
    expect(isPendingCallConsumed({ consumedAt: new Date() })).toBe(true)
    expect(isPendingCallConsumed({ consumedAt: null })).toBe(false)
  })
})

describe("verifyPendingCall — credential matching", () => {
  it("all checks pass → ok", () => {
    expect(verifyPendingCall(baseRecord(), ctx())).toEqual({ ok: true })
  })

  it("expired → reason: expired", () => {
    const out = verifyPendingCall(
      baseRecord({ expiresAt: new Date(Date.now() - 1000) }),
      ctx(),
    )
    expect(out).toEqual({ ok: false, reason: "expired" })
  })

  it("injected now controls the expiry boundary", () => {
    const rec = baseRecord({ expiresAt: new Date(1_000) })
    expect(verifyPendingCall(rec, ctx({ now: new Date(2_000) }))).toEqual({
      ok: false,
      reason: "expired",
    })
    expect(verifyPendingCall(rec, ctx({ now: new Date(500) }))).toEqual({ ok: true })
  })

  it("already consumed → reason: consumed (checked before expiry)", () => {
    const out = verifyPendingCall(baseRecord({ consumedAt: new Date() }), ctx())
    expect(out).toEqual({ ok: false, reason: "consumed" })
  })

  it("owner or scope mismatch → reason: owner_mismatch", () => {
    expect(verifyPendingCall(baseRecord({ ownerId: "u2" }), ctx())).toEqual({
      ok: false,
      reason: "owner_mismatch",
    })
    expect(verifyPendingCall(baseRecord({ scopeId: "t2" }), ctx())).toEqual({
      ok: false,
      reason: "owner_mismatch",
    })
    // Scoped credential cannot be consumed without presenting the scope.
    expect(verifyPendingCall(baseRecord(), ctx({ scopeId: null }))).toEqual({
      ok: false,
      reason: "owner_mismatch",
    })
    // Unscoped credential cannot be consumed inside a scope either.
    expect(verifyPendingCall(baseRecord({ scopeId: null }), ctx())).toEqual({
      ok: false,
      reason: "owner_mismatch",
    })
    // Both unscoped → fine.
    expect(verifyPendingCall(baseRecord({ scopeId: null }), ctx({ scopeId: null }))).toEqual({
      ok: true,
    })
  })

  it("tool name mismatch → reason: tool_mismatch", () => {
    expect(verifyPendingCall(baseRecord(), ctx({ toolName: "updateOrder" }))).toEqual({
      ok: false,
      reason: "tool_mismatch",
    })
  })

  it("args hash mismatch → reason: args_mismatch", () => {
    const out = verifyPendingCall(baseRecord(), ctx({ argsHash: hashArgs({ name: "other" }) }))
    expect(out).toEqual({ ok: false, reason: "args_mismatch" })
  })
})

describe("extractWriteToolCalls — pull write calls from model output", () => {
  const isWrite = (name: string) => name === "createOrder" || name === "updateOrder"

  it("extracts write calls with argsHash; skips read tools (AI SDK v4 shape)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", toolCallId: "c1", toolName: "createOrder", args: { name: "tour" } },
          { type: "tool-call", toolCallId: "c2", toolName: "getOrders", args: {} },
        ],
      },
    ]
    const out = extractWriteToolCalls(messages, isWrite)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      toolCallId: "c1",
      toolName: "createOrder",
      argsHash: hashArgs({ name: "tour" }),
      argsCanonical: canonicalArgsJson({ name: "tour" }),
    })
  })

  it("argsCanonical and argsHash share one source: sha256(canonical) === argsHash", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "createOrder", args: { b: 2, a: 1 } },
        ],
      },
    ]
    const [call] = extractWriteToolCalls(messages, isWrite)
    expect(createHash("sha256").update(call.argsCanonical).digest("hex")).toBe(call.argsHash)
    expect(call.argsCanonical).toBe(canonicalArgsJson({ a: 1, b: 2 }))
  })

  it("supports AI SDK v5 shapes: `input` field and `tool-<name>` part types", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          // v5 ModelMessage: input instead of args
          { type: "tool-call", toolCallId: "c1", toolName: "createOrder", input: { name: "v5" } },
          // v5 UIMessage: tool name embedded in the part type
          { type: "tool-updateOrder", toolCallId: "c2", state: "input-available", input: { id: 7 } },
        ],
      },
    ]
    const out = extractWriteToolCalls(messages, isWrite)
    expect(out).toHaveLength(2)
    expect(out[0].argsHash).toBe(hashArgs({ name: "v5" }))
    expect(out[1].toolName).toBe("updateOrder")
    expect(out[1].argsHash).toBe(hashArgs({ id: 7 }))
  })

  it("skips UI parts in streaming/output states (incomplete or already-run args)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-createOrder", toolCallId: "c1", state: "input-streaming", input: { name: "par" } },
          { type: "tool-createOrder", toolCallId: "c2", state: "output-available", input: { name: "done" }, output: {} },
          { type: "tool-createOrder", toolCallId: "c3", state: "input-available", input: { name: "ready" } },
        ],
      },
    ]
    const out = extractWriteToolCalls(messages, isWrite)
    expect(out).toHaveLength(1)
    expect(out[0].toolCallId).toBe("c3")
    expect(out[0].argsHash).toBe(hashArgs({ name: "ready" }))
  })

  it("dedupes on toolCallId (first wins)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "createOrder", args: { name: "a" } },
          { type: "tool-call", toolCallId: "c1", toolName: "createOrder", args: { name: "b" } },
        ],
      },
    ]
    const out = extractWriteToolCalls(messages, isWrite)
    expect(out).toHaveLength(1)
    expect(out[0].argsHash).toBe(hashArgs({ name: "a" }))
  })

  it("non-array / no tool parts → empty array (tolerant)", () => {
    expect(extractWriteToolCalls(undefined, isWrite)).toEqual([])
    expect(extractWriteToolCalls([{ role: "assistant", content: "plain text" }], isWrite)).toEqual([])
  })
})

describe("argsPreviewFromCanonical — approval-queue argument preview", () => {
  const canon = (v: unknown) => canonicalArgsJson(v)
  const hash = (v: unknown) => hashArgs(v)

  it("renders per-field items, skipping empty values", () => {
    const args = { name: "tour", adultCount: 15, remark: "" }
    const out = argsPreviewFromCanonical(canon(args), hash(args))
    expect(out).toEqual([
      { key: "adultCount", value: "15", redacted: false },
      { key: "name", value: "tour", redacted: false },
    ])
    expect(out?.some((i) => i.key === "remark")).toBe(false)
  })

  it("sensitive keys (top-level + nested) are redacted to ***", () => {
    const args = {
      name: "alice",
      idNumber: "310101199001011234",
      tourists: [{ name: "bob", idNumber: "X" }],
    }
    const out = argsPreviewFromCanonical(canon(args), hash(args))
    expect(out?.find((i) => i.key === "idNumber")).toEqual({
      key: "idNumber",
      value: "***",
      redacted: true,
    })
    const tItem = out?.find((i) => i.key === "tourists")
    expect(tItem?.value).toContain("***")
    expect(tItem?.value).toContain("bob")
    expect(tItem?.value).not.toContain("X")
  })

  it("tamper gate: canonical that does not hash to argsHash → null", () => {
    const canonical = canon({ name: "real" })
    expect(argsPreviewFromCanonical(canonical, hash({ name: "swapped" }))).toBeNull()
  })

  it("unparseable JSON → null", () => {
    const bad = "{not valid json"
    const h = createHash("sha256").update(bad).digest("hex")
    expect(argsPreviewFromCanonical(bad, h)).toBeNull()
  })
})
