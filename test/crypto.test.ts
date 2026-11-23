import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { sealText, openText, maskSecret } from "../src/crypto.js"
import { argsPreviewFromCanonical, canonicalArgsJson } from "../src/index.js"

describe("sealText / openText — AES-256-GCM argument sealing", () => {
  it("roundtrips plaintext", () => {
    const sealed = sealText('{"name":"tour"}', "correct horse battery staple")
    expect(openText(sealed, "correct horse battery staple")).toBe('{"name":"tour"}')
  })

  it("produces different ciphertext for identical plaintext (random salt+iv)", () => {
    const a = sealText("same", "key")
    const b = sealText("same", "key")
    expect(a).not.toBe(b)
  })

  it("wrong passphrase → throws (GCM auth tag)", () => {
    const sealed = sealText("secret", "right")
    expect(() => openText(sealed, "wrong")).toThrow()
  })

  it("tampered ciphertext → throws", () => {
    const sealed = sealText("secret", "key")
    const parts = sealed.split(".")
    const data = Buffer.from(parts[3], "base64")
    data[0] ^= 0xff
    parts[3] = data.toString("base64")
    expect(() => openText(parts.join("."), "key")).toThrow()
  })

  it("malformed input → throws", () => {
    expect(() => openText("not-a-ciphertext", "key")).toThrow(/malformed/)
    expect(() => openText("a.b.c", "key")).toThrow(/malformed/)
  })
})

describe("maskSecret", () => {
  it("reveals at most the last 4 characters", () => {
    expect(maskSecret("sk-abcdefgh1234")).toBe("•".repeat(11) + "1234")
    expect(maskSecret("abcd")).toBe("••••")
    expect(maskSecret("")).toBe("")
  })
})

describe("sealed args → audit preview integration", () => {
  it("openText(sealedArgs) feeds argsPreviewFromCanonical with hash self-check", () => {
    const args = { orderId: "o1", passport: "P123456", note: "vip" }
    const canonical = canonicalArgsJson(args)
    const argsHash = createHash("sha256").update(canonical).digest("hex")

    const sealed = sealText(canonical, "audit-key")
    const opened = openText(sealed, "audit-key")
    const preview = argsPreviewFromCanonical(opened, argsHash)

    expect(preview).not.toBeNull()
    expect(preview?.find((i) => i.key === "passport")).toEqual({
      key: "passport",
      value: "***",
      redacted: true,
    })
    expect(preview?.find((i) => i.key === "orderId")?.value).toBe("o1")
  })
})
