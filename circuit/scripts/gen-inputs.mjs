// Generate sample public/private inputs for both circuits.
// The gradient circuit needs commit = Poseidon(y, s), computed here with the
// SAME Poseidon as circomlib's poseidon.circom (via circomlibjs).
import { buildPoseidon } from "circomlibjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // circuit/
mkdirSync(join(ROOT, "inputs"), { recursive: true });

const poseidon = await buildPoseidon();
const F = poseidon.F;

// ---- update_gradient: B computes x' = x + y on a committed secret y ----
const x = 100;
const y = 8; // secret gradient
const s = 1234567890123n; // salt (kept private, reused per session)
const y_max = 1_000_000;
const commit = F.toObject(poseidon([y, s])); // = Poseidon(y, s)
const gradientInput = {
  y: String(y),
  s: s.toString(),
  x: String(x),
  x_prime: String(x + y),
  commit: commit.toString(),
  y_max: String(y_max),
};
writeFileSync(
  join(ROOT, "inputs", "update_gradient.input.json"),
  JSON.stringify(gradientInput, null, 2),
);

// ---- update_model: A averages [108, 107] -> 107.5 => floor 107, remainder 1 ----
const updates = [108, 107];
const N = updates.length;
const sum = updates.reduce((a, b) => a + b, 0);
const x_new = Math.floor(sum / N);
const remainder = sum - N * x_new;
const modelInput = {
  updates: updates.map(String),
  x_new: String(x_new),
  remainder: String(remainder),
};
writeFileSync(
  join(ROOT, "inputs", "update_model.input.json"),
  JSON.stringify(modelInput, null, 2),
);

console.log("inputs written:");
console.log("  update_gradient:", gradientInput);
console.log("  update_model   :", modelInput);
