import { createHash, randomUUID } from "node:crypto";

export function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// Deterministic canonical serialization: object keys sorted, undefined omitted,
// no incidental whitespace. Two parties feeding the same logical fields produce
// byte-identical output, hence identical hashes across processes.
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalize: non-finite number is not allowed");
    }
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error("canonicalize: unsupported type " + t);
}

export { randomUUID };