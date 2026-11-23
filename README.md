# toolcall-guard

Single-use approval credentials for LLM tool calls.

When an AI agent proposes a **write** operation, don't just show a confirm
dialog — issue a cryptographic credential that binds *what the model
proposed* to *what a human approved*. `toolcall-guard` makes the approval
enforceable: replay-proof, forgery-proof, and argument-tamper-proof.

```ts
import { createToolCallGuard, createPrismaStore } from "toolcall-guard"

const guard = createToolCallGuard({ store: createPrismaStore(prisma) })

// 1. Model proposes writes → issue one credential per write call
for (const call of extractWriteToolCalls(response.messages, isWriteTool)) {
  await guard.issue({
    conversationId, toolCallId: call.toolCallId, toolName: call.toolName,
    args: JSON.parse(call.argsCanonical), ownerId: session.userId, scopeId: session.tenantId,
    sealedArgs: sealText(call.argsCanonical, env.SECRET),
  })
}

// 2. Human confirms → consume exactly once, then execute
const result = await guard.consume({
  conversationId, toolCallId, toolName, args, ownerId: session.userId, scopeId: session.tenantId,
})
if (result.ok) await executeTool(toolName, args) // safe: verified + consumed atomically
```

## The problem it solves

"Human-in-the-loop" confirmations are usually UI-only: the client sends
`{tool, args}` to an execute endpoint and the server trusts it. That leaves
four real attack/bug surfaces:

| Threat | Without a credential | With toolcall-guard |
|---|---|---|
| **Replay** — resubmit a confirmed call | Executes again | `consumedAt` atomic flip → second attempt rejected |
| **Forged call** — invent a `toolCallId` the model never proposed | Executes unreviewed args | No credential exists → `not_found` |
| **Arg swap** — approve `amount: 100`, send `amount: 99999` | Executes tampered args | `argsHash` mismatch → `args_mismatch` |
| **Cross-principal** — consume someone else's pending approval | Executes under wrong identity | `ownerId`/`scopeId` binding → `owner_mismatch` |

The credential is issued **server-side** when the model responds, and
consumed **server-side** inside the same trust boundary as your auth —
the client only ever carries opaque IDs.

## How it works

```
model response ──► extractWriteToolCalls() ──► guard.issue()
                     (args → canonical JSON      (stores argsHash,
                      → sha256)                   owner, expiry, sealedArgs)
                                                        │
human clicks confirm ──► POST {convId, callId,          ▼
                          tool, args}            guard.consume()
                                                    find → verify(owner,
                                                    tool, expiry, argsHash)
                                                    → tryConsume (atomic)
                                                        │
                                              ok → execute tool
                                              !ok → reject, nothing runs
```

Three properties make this airtight:

1. **Canonical hashing** — `hashArgs` serializes args with recursively
   sorted keys, so `{a:1,b:2}` and `{b:2,a:1}` hash identically while any
   value change breaks the hash. The model's proposal and the client's
   confirmation are compared on equal footing.
2. **Atomic consumption** — `tryConsume` is a compare-and-set
   (`UPDATE … WHERE consumed_at IS NULL`). Under concurrent confirms,
   exactly one wins; everyone else gets `consumed`.
3. **Fail-closed verification** — owner, tool name, expiry, and args hash
   are all checked before consumption; first failure rejects with a
   specific reason.

## Quickstart

```bash
npm install toolcall-guard
```

### 1. Storage

Pick one:

- **Prisma** (recommended): paste [`schema.prisma`](./schema.prisma) into
  your schema, run `prisma migrate dev`, then `createPrismaStore(prisma)`.
- **Memory**: `createMemoryStore()` — tests and single-process dev only.
- **Anything else**: implement the three-method `PendingCallStore`
  interface (`find` / `upsert` / `tryConsume`). `tryConsume` must be
  atomic — that's the replay gate.

### 2. Issue on the model path

```ts
import { extractWriteToolCalls, hashArgs, canonicalArgsJson } from "toolcall-guard"

const WRITE_TOOLS = new Set(["createOrder", "updateOrder", "deleteOrder"])

const calls = extractWriteToolCalls(response.messages, (n) => WRITE_TOOLS.has(n))
for (const call of calls) {
  await guard.issue({
    conversationId: msg.conversationId,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: JSON.parse(call.argsCanonical),
    ownerId: session.user.id,
    scopeId: session.tenantId,          // optional multi-tenant binding
    ttlMs: 10 * 60 * 1000,             // default: 10 minutes
    sealedArgs: sealText(call.argsCanonical, process.env.APP_SECRET!),
  })
}
```

`extractWriteToolCalls` understands both AI SDK v4 (`type:"tool-call"`,
`args`) and v5 (`type:"tool-<name>"` UI parts, `input` field) message
shapes, and any framework that emits similar parts.

### 3. Consume on the confirm path

```ts
app.post("/api/agent/confirm-tool", async (req, res) => {
  const { conversationId, toolCallId, tool, args } = req.body
  const session = await getSession(req)          // your auth
  if (!session) return res.status(401).end()

  const result = await guard.consume({
    conversationId, toolCallId,
    toolName: tool, args,
    ownerId: session.user.id,
    scopeId: session.tenantId,
  })

  if (!result.ok) {
    // reason ∈ not_found | expired | consumed | owner_mismatch
    //        | tool_mismatch | args_mismatch
    return res.status(rejectionStatus(result.reason)).json({ error: result.reason })
  }

  const data = await executeWriteTool(tool, args) // only reached once, verified
  res.json({ ok: true, data })
})
```

A failed `consume` never partially executes — verification happens
before the atomic flip, and the flip happens before your tool runs.

### 4. (Optional) Human-readable preview with redaction

```ts
const record = await guard.find(conversationId, toolCallId)
if (record?.sealedArgs) {
  const canonical = openText(record.sealedArgs, process.env.APP_SECRET!)
  const preview = argsPreviewFromCanonical(canonical, record.argsHash)
  // → [{ key: "amount", value: "100", redacted: false },
  //    { key: "passport", value: "***", redacted: true }, …]
}
```

`argsPreviewFromCanonical` re-hashes the decrypted canonical args and
refuses to render if it doesn't match `argsHash` — a tampered store row
can never display arguments that differ from what will execute.
`SENSITIVE_ARG_KEY` redacts credentials/PII-looking keys (English +
Chinese field names) recursively.

## API surface

| Export | Purpose |
|---|---|
| `createToolCallGuard({store, ttlMs?, now?})` | high-level issue/consume/find |
| `extractWriteToolCalls(messages, isWriteTool)` | pull write calls + hash args from model output |
| `canonicalArgsJson` / `hashArgs` | stable serialization + sha256 |
| `verifyPendingCall` / `isPendingCallExpired` / `isPendingCallConsumed` | pure verification primitives |
| `createPrismaStore(client)` | Prisma adapter (duck-typed delegate) |
| `createMemoryStore()` | in-memory store for tests/dev |
| `PendingCallStore` | the 3-method storage interface |
| `sealText` / `openText` / `maskSecret` | optional AES-256-GCM sealing for `sealedArgs` |
| `argsPreviewFromCanonical` / `redactSensitiveValue` / `SENSITIVE_ARG_KEY` | redacted approval previews |

Rejection reasons map cleanly to HTTP: `not_found`/`consumed`/`expired`
→ 409, `owner_mismatch`/`tool_mismatch`/`args_mismatch` → 403.

## What this is NOT

- **Not an approval UI.** It issues and enforces credentials; your
  frontend renders the confirm dialog (plenty of inbox-style libs exist
  for that — this is the enforcement layer underneath them).
- **Not an authorizer.** It proves *a specific proposal was approved
  once*; it does not decide *whether* the user may call the tool — keep
  your RBAC checks.
- **Not a session mechanism.** `ownerId`/`scopeId` are opaque strings
  you supply from your own auth context.
- **Not multi-use.** One credential, one execution, by design.

## Design notes

- **Why hash args instead of storing them?** The credential stays small
  and the binding is tamper-evident: `argsHash` is computed identically
  at issuance and confirmation, so any mutation — including key reordering
  that JSON would normally hide — is caught or normalized correctly.
- **Why not reset `consumedAt` on re-issue?** Upserting the same
  `(conversationId, toolCallId)` refreshes proposal fields and expiry but
  preserves owner, scope, and consumption state. A consumed credential
  can never be resurrected — re-issuing is for retrying an *unconsumed*
  proposal only.
- **Why a store interface?** The three operations map onto any database;
  the atomic `tryConsume` is the only hard requirement. Prisma ships in
  the box; Drizzle/SQL/Redis adapters are ~50 lines each.

## Development

```bash
npm install
npm test        # vitest — 46 tests
npm run typecheck
npm run build   # tsc → dist/
```

Node ≥ 20. Zero runtime dependencies — `node:crypto` only.

## License

MIT
