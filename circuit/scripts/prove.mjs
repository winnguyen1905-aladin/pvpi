// Generate a Groth16 proof for one circuit using the SAVED proving key (.zkey).
//   usage: node scripts/prove.mjs <update_gradient|update_model>
import * as snarkjs from "snarkjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // circuit/
const c = process.argv[2];
if (!c) {
  console.error("usage: node scripts/prove.mjs <update_gradient|update_model>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(join(ROOT, "inputs", `${c}.input.json`), "utf8"));
const wasm = join(ROOT, "build", c, `${c}_js`, `${c}.wasm`);
const zkey = join(ROOT, "keys", `${c}.zkey`); // <-- reused proving key

const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);

mkdirSync(join(ROOT, "proofs"), { recursive: true });
writeFileSync(join(ROOT, "proofs", `${c}.proof.json`), JSON.stringify(proof, null, 2));
writeFileSync(join(ROOT, "proofs", `${c}.public.json`), JSON.stringify(publicSignals, null, 2));

console.log(`[${c}] proof written -> proofs/${c}.proof.json`);
console.log(`[${c}] public signals:`, publicSignals);
process.exit(0); // snarkjs keeps a worker pool alive; force a clean exit
