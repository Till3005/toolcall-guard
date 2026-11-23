/**
 * Sensitive-argument redaction for human-facing previews of pending calls.
 *
 * When a queued approval is shown to a human (or written to an audit log),
 * arguments that look like credentials or PII must never render in clear.
 * Keys matching SENSITIVE_ARG_KEY have their values replaced with "***",
 * recursively through nested objects and arrays.
 */
import { createHash } from "node:crypto"

/**
 * Key names whose values are always redacted. Covers common English and
 * Chinese field names for IDs, documents, banking, credentials, and contact.
 */
export const SENSITIVE_ARG_KEY =
  /idnumber|身份证|证件|passport|bankaccount|bankcard|银行卡|银行账|开户|账号|account.?no|password|passwd|secret|token|apikey|api.?key|phone|mobile|手机|手机号/i

export interface ArgPreviewItem {
  key: string
  value: string
  /** true when the value matched a sensitive key and was replaced with "***". */
  redacted: boolean
}

/** Recursively replace sensitive-keyed values with "***". */
export function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveValue)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_ARG_KEY.test(k) ? "***" : redactSensitiveValue(v)
    }
    return out
  }
  return value
}

/**
 * Build a human-readable argument list from the canonical args JSON stored
 * alongside a credential.
 *
 * Tamper gate: the stored canonical string must hash to the credential's
 * `argsHash`. If it does not (corruption or tampering), returns null rather
 * than displaying arguments that do not match what will execute.
 */
export function argsPreviewFromCanonical(
  canonical: string,
  argsHash: string,
): ArgPreviewItem[] | null {
  if (createHash("sha256").update(canonical).digest("hex") !== argsHash) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(canonical)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ key: "arguments", value: JSON.stringify(redactSensitiveValue(parsed)), redacted: false }]
  }
  const items: ArgPreviewItem[] = []
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue
    const sensitive = SENSITIVE_ARG_KEY.test(k)
    const redacted = sensitive ? "***" : redactSensitiveValue(v)
    items.push({
      key: k,
      value: typeof redacted === "object" ? JSON.stringify(redacted) : String(redacted),
      redacted: sensitive,
    })
  }
  return items
}
