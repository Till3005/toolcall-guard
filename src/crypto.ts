/**
 * Optional AES-256-GCM sealing for stored tool-call arguments.
 *
 * The credential's security never depends on this module — `argsHash` is the
 * binding; sealing only protects the *contents* of the canonical args when
 * they are persisted for later audit or human preview. Use it when you want
 * "what exactly was approved" recoverable without storing plaintext.
 *
 * Format (self-describing, no external parameters needed to decrypt):
 *   base64(salt) "." base64(iv) "." base64(authTag) "." base64(ciphertext)
 *
 * Keys are derived from a caller-supplied passphrase via scrypt with a
 * per-ciphertext random salt, so one leaked ciphertext does not endanger
 * others and no key-management infrastructure is required.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_LEN = 32
const IV_LEN = 12
const SALT_LEN = 16
const SEP = "."

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN)
}

/** Seal plaintext; returns the self-describing ciphertext string. */
export function sealText(plain: string, passphrase: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [salt, iv, authTag, ciphertext].map((b) => b.toString("base64")).join(SEP)
}

/**
 * Open a ciphertext produced by sealText. Throws on malformed input or any
 * tampering (GCM auth tag verification).
 */
export function openText(ciphertext: string, passphrase: string): string {
  const parts = ciphertext.split(SEP)
  if (parts.length !== 4) throw new Error("malformed ciphertext: expected 4 dot-separated parts")
  const [saltB64, ivB64, tagB64, dataB64] = parts
  const salt = Buffer.from(saltB64, "base64")
  const iv = Buffer.from(ivB64, "base64")
  const authTag = Buffer.from(tagB64, "base64")
  const data = Buffer.from(dataB64, "base64")
  if (salt.length !== SALT_LEN || iv.length !== IV_LEN) {
    throw new Error("malformed ciphertext: bad salt/iv length")
  }
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

/** Mask a secret for display, revealing at most the last 4 characters. */
export function maskSecret(secret: string): string {
  if (!secret) return ""
  if (secret.length <= 4) return "•".repeat(secret.length)
  return "•".repeat(secret.length - 4) + secret.slice(-4)
}
