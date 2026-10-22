import { describe, expect, it } from "vitest";
import { base64url, newKeyPair, PROOF_PREFIX, publicKeyOf, signChallenge } from "./deviceKey";

function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

describe("the device key (R3)", () => {
  it("encodes base64url without padding", () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
  });

  it("sends the public half as the uncompressed point, and signs the challenge as r‖s", async () => {
    const pair = await newKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    const raw = fromBase64url(await publicKeyOf(pair));
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    const sig = fromBase64url(await signChallenge(pair.privateKey, "abc"));
    expect(sig.length).toBe(64);
    // What the desktop checks (`auth::proof_ok`): the prefix and the challenge, under the sent key.
    const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    const check = (text: string) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(text));
    expect(await check(PROOF_PREFIX + "abc")).toBe(true);
    expect(await check(PROOF_PREFIX + "abd")).toBe(false);
  });
});
