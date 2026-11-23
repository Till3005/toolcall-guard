/**
 * Core pure logic for single-use tool-call approval credentials.
 *
 * No I/O, no database, no framework imports — every function here is
 * deterministic and unit-testable in isolation.
 */
import { createHash } from "node:crypto"

/* ------------------------------------------------------------------ */
/* Canonical JSON + argument hashing                                   */
/* ------------------------------------------------------------------ */

/**
 * Serialize a value to JSON with recursively sorted object keys, so that
 * `{a:1,b:2}` and `{b:2,a:1}` produce the identical string. Array order is
 * preserved — order is semantic. `undefined` normalizes to `null`.
 */
export function canonicalArgsJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = normalize(obj[key])
    }
    return out
  }
  return value
}

/** sha256 hex of the canonical args JSON. Key-order independent. */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalArgsJson(args)).digest("hex")
}

/* ------------------------------------------------------------------ */
/* Credential records and verification                                 */
/* ------------------------------------------------------------------ */

/**
 * A persisted approval credential. `scopeId` is an optional tenant/workspace
 * discriminator — when set on both record and request it must match; a
 * credential issued inside a scope can never be consumed outside it.
 */
export interface PendingToolCallRecord {
  id: string
  conversationId: string
  toolCallId: string
  toolName: string
  /** sha256 of canonicalArgsJson(args) at issuance time. */
  argsHash: string
  /** Optional sealed canonical args (see crypto.ts) for audit/preview. */
  sealedArgs?: string | null
  ownerId: string
  scopeId?: string | null
  expiresAt: Date
  consumedAt: Date | null
}

/** What the caller presents when confirming execution. */
export interface ConfirmContext {
  toolName: string
  ownerId: string
  scopeId?: string | null
  /** hashArgs() of the args being executed. */
  argsHash: string
  /** Evaluation instant — injectable for tests. */
  now?: Date
}

export type PendingCallRejection =
  | "expired"
  | "consumed"
  | "owner_mismatch"
  | "tool_mismatch"
  | "args_mismatch"

export type PendingCallVerdict = { ok: true } | { ok: false; reason: PendingCallRejection }

export function isPendingCallExpired(
  record: Pick<PendingToolCallRecord, "expiresAt">,
  now: Date = new Date(),
): boolean {
  return record.expiresAt.getTime() <= now.getTime()
}

export function isPendingCallConsumed(
  record: Pick<PendingToolCallRecord, "consumedAt">,
): boolean {
  return record.consumedAt !== null && record.consumedAt !== undefined
}

/**
 * Full match check between a fetched credential and a confirm request.
 * First failing check wins, in this order:
 *   1. owner (+scope when used) — nobody consumes another principal's credential
 *   2. tool name — the approved tool is the only executable one
 *   3. consumed — replay rejection
 *   4. expired — stale proposals die
 *   5. args hash — arguments cannot be swapped after approval
 */
export function verifyPendingCall(
  record: PendingToolCallRecord,
  ctx: ConfirmContext,
): PendingCallVerdict {
  const recordScope = record.scopeId ?? null
  const ctxScope = ctx.scopeId ?? null
  if (record.ownerId !== ctx.ownerId || recordScope !== ctxScope) {
    return { ok: false, reason: "owner_mismatch" }
  }
  if (record.toolName !== ctx.toolName) {
    return { ok: false, reason: "tool_mismatch" }
  }
  if (isPendingCallConsumed(record)) {
    return { ok: false, reason: "consumed" }
  }
  if (isPendingCallExpired(record, ctx.now ?? new Date())) {
    return { ok: false, reason: "expired" }
  }
  if (record.argsHash !== ctx.argsHash) {
    return { ok: false, reason: "args_mismatch" }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Extracting write-tool proposals from model output                   */
/* ------------------------------------------------------------------ */

/** A write-tool call extracted from a model response, ready to credential. */
export interface ExtractedToolCall {
  toolCallId: string
  toolName: string
  /** sha256 of the canonical args — same canonicalization confirm uses. */
  argsHash: string
  /** canonicalArgsJson(args). Invariant: sha256(argsCanonical) === argsHash. */
  argsCanonical: string
}

interface ToolCallPart {
  type?: unknown
  toolCallId?: unknown
  toolName?: unknown
  args?: unknown
  input?: unknown
  state?: unknown
}

/**
 * UIMessage part states that must never produce a credential: streaming
 * parts carry incomplete args, and output-* parts mean the call already
 * executed — re-confirming would double-run it.
 */
const SKIPPED_PART_STATES = new Set([
  "input-streaming",
  "output-available",
  "output-error",
  "output-denied",
])

function partToolName(part: ToolCallPart): string | null {
  if (part.type === "tool-call" && typeof part.toolName === "string") {
    return part.toolName
  }
  // AI SDK v5 UIMessage style: { type: "tool-<name>", toolCallId, input }
  if (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    part.type !== "tool-call"
  ) {
    return part.type.slice("tool-".length)
  }
  return null
}

function partArgs(part: ToolCallPart): unknown {
  // AI SDK ≤4 uses `args`, v5 ModelMessage uses `input`.
  return part.args !== undefined ? part.args : part.input
}

/**
 * Pull write-tool calls out of a model response's messages and hash their
 * args. Tolerant of shape variation: walks `messages[].content[]` looking
 * for tool-call parts in both AI SDK v4 (`type:"tool-call"`, `args`) and
 * v5 (`type:"tool-<name>"` UI parts / `input` field) encodings.
 *
 * Pure function — the caller decides which tools are writes via `isWriteTool`
 * and persists the results (see store.ts / guard.ts).
 */
export function extractWriteToolCalls(
  messages: unknown,
  isWriteTool: (toolName: string) => boolean,
): ExtractedToolCall[] {
  if (!Array.isArray(messages)) return []
  const out: ExtractedToolCall[] = []
  const seen = new Set<string>()
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const p = part as ToolCallPart
      if (typeof p.toolCallId !== "string") continue
      if (typeof p.state === "string" && SKIPPED_PART_STATES.has(p.state)) continue
      const toolName = partToolName(p)
      if (toolName === null || !isWriteTool(toolName)) continue
      if (seen.has(p.toolCallId)) continue
      seen.add(p.toolCallId)
      const canonical = canonicalArgsJson(partArgs(p) ?? {})
      out.push({
        toolCallId: p.toolCallId,
        toolName,
        argsHash: createHash("sha256").update(canonical).digest("hex"),
        argsCanonical: canonical,
      })
    }
  }
  return out
}
