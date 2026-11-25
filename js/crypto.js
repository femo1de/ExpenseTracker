// Web Crypto PBKDF2-SHA256 + AES-256-GCM helpers.
// Runs identically in modern browsers and Node.js (>= 20).

export const PBKDF2_ITERATIONS = 210000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function getSubtle() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle) {
    throw new Error("Web Crypto API is unavailable. Serve the app over HTTPS or localhost.");
  }
  return cryptoObj;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(password, saltBytes, usages) {
  const cryptoObj = getSubtle();
  const keyMaterial = await cryptoObj.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoObj.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export async function encryptToken(token, password) {
  if (!token || typeof token !== "string") {
    throw new Error("Token must be a non-empty string.");
  }
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string.");
  }

  const cryptoObj = getSubtle();
  const salt = cryptoObj.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = cryptoObj.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(password, salt, ["encrypt"]);
  const plaintext = new TextEncoder().encode(token);

  const ciphertext = await cryptoObj.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    encryptedToken: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptToken(payload, password) {
  if (!payload || !payload.salt || !payload.iv || !payload.encryptedToken) {
    throw new Error("Encrypted token configuration is missing.");
  }
  if (!password || typeof password !== "string") {
    throw new Error("Please enter your password.");
  }

  const cryptoObj = getSubtle();
  const salt = base64ToBytes(payload.salt);
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.encryptedToken);
  const key = await deriveAesKey(password, salt, ["decrypt"]);

  try {
    const decrypted = await cryptoObj.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("Incorrect password.");
  }
}

export function isUserConfigured(user) {
  return Boolean(
    user &&
      typeof user.salt === "string" &&
      user.salt.trim() &&
      typeof user.iv === "string" &&
      user.iv.trim() &&
      typeof user.encryptedToken === "string" &&
      user.encryptedToken.trim()
  );
}
