// Verify a Groth16 proof against the SAVED verification key (.vkey.json).
//   usage: node scripts/verify.mjs <update_gradient|update_model>
import * as snarkjs from "snarkjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // circuit/
const c = process.argv[2];
if (!c) {
  console.error("usage: node scripts/verify.mjs <update_gradient|update_model>");
  process.exit(2);
}

const vkey = JSON.parse(readFileSync(join(ROOT, "keys", `${c}.vkey.json`), "utf8")); // <-- reused vk
const proof = JSON.parse(readFileSync(join(ROOT, "proofs", `${c}.proof.json`), "utf8"));
const pub = JSON.parse(readFileSync(join(ROOT, "proofs", `${c}.public.json`), "utf8"));

const ok = await snarkjs.groth16.verify(vkey, pub, proof);
console.log(`[${c}] verify =`, ok);
process.exit(ok ? 0 : 1);
