import test from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken, isUserConfigured } from "../js/crypto.js";

test("encryptToken and decryptToken round-trip with valid password", async () => {
  const secretToken = "github_pat_example_1234567890_ABCDEF";
  const encrypted = await encryptToken(secretToken, "sunshine-trip");

  assert.ok(encrypted.salt.length > 0);
  assert.ok(encrypted.iv.length > 0);
  assert.ok(encrypted.encryptedToken.length > 0);
  assert.notEqual(encrypted.encryptedToken, secretToken);
  assert.ok(!encrypted.encryptedToken.includes("github_pat_"));

  const decrypted = await decryptToken(encrypted, "sunshine-trip");
  assert.equal(decrypted, secretToken);
});

test("decryptToken rejects wrong password", async () => {
  const encrypted = await encryptToken("github_pat_secret", "right-password");
  await assert.rejects(() => decryptToken(encrypted, "wrong-password"), /Incorrect password/);
});

test("encryptToken produces unique ciphertext for same token and password", async () => {
  const first = await encryptToken("token-abc", "same-pw");
  const second = await encryptToken("token-abc", "same-pw");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.encryptedToken, second.encryptedToken);
});

test("isUserConfigured detects placeholder vs configured entries", () => {
  assert.equal(isUserConfigured({ salt: "", iv: "", encryptedToken: "" }), false);
  assert.equal(isUserConfigured({ salt: "a", iv: "b", encryptedToken: "c" }), true);
});
