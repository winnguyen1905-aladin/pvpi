// Browser re-implementation of the backend's hashing/signing scheme, used by the
// "immutability" demo to recompute hashes and verify signatures client-side. Mirrors
// src/utils/crypto.ts (canonicalize), src/model/merkle-leaf.model.ts (inner/leaf hash)
// and src/model/merkle-tree.model.ts (0x01 internal nodes, promote-odd). Needs a secure
// context (served on http://localhost) so window.crypto.subtle (Ed25519) is available.

// Deterministic canonical JSON: keys sorted, undefined omitted, no whitespace.
export function canonicalize(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  throw new Error("canonicalize: unsupported type " + t);
}

const enc = new TextEncoder();
const hexToBytes = (hex) => {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
};
const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256hex(input) {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

// inner_hash = SHA256(canonical(fields)) — the signed bytes.
export const innerHash = (fields) => sha256hex(canonicalize(fields));

// leaf_hash = SHA256(0x00 || canonical(fields + signature)).
export async function leafHash(fields, signature) {
  const body = enc.encode(canonicalize({ ...fields, signature }));
  const buf = new Uint8Array(1 + body.length);
  buf[0] = 0x00;
  buf.set(body, 1);
  return sha256hex(buf);
}

// internal node = SHA256(0x01 || left_bytes || right_bytes).
async function hashInternal(left, right) {
  const L = hexToBytes(left), R = hexToBytes(right);
  const buf = new Uint8Array(1 + L.length + R.length);
  buf[0] = 0x01;
  buf.set(L, 1);
  buf.set(R, 1 + L.length);
  return sha256hex(buf);
}

// Merkle root over leaf_hash values (lone odd node promoted unchanged).
export async function merkleRoot(leafHashes) {
  let cur = [...leafHashes];
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? await hashInternal(cur[i], cur[i + 1]) : cur[i]);
    }
    cur = next;
  }
  return cur[0];
}

async function importSpkiPublic(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("spki", der, { name: "Ed25519" }, true, ["verify"]);
}

// Verify the leaf's Ed25519 signature over its inner_hash with the author's public PEM.
// (The backend signs the raw 32 bytes of inner_hash; Ed25519 is verified over those bytes.)
export async function verifyLeafSignature(fields, signatureHex, publicKeyPem) {
  try {
    const key = await importSpkiPublic(publicKeyPem);
    const msg = hexToBytes(await innerHash(fields));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(signatureHex), msg);
  } catch {
    return false;
  }
}

export const cryptoAvailable = () => !!(window.crypto && window.crypto.subtle);
