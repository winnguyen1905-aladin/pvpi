# circuit — D2 Verifiable Computation (ZK SNARK)

Groth16 (BN254) zero-knowledge circuits for **Direction 2** of the design doc
*"Blockchain Audit Layer, Federated Learning, Private Set Intersection"* (§D2).

Two circuits, the two honesty checks of one FL round:

| Circuit | Who proves | What it proves | Privacy |
|---------|-----------|----------------|---------|
| `update_gradient` | trainer B/C | `x' = x + y` on a committed secret `y` | `y` stays secret |
| `update_model` | aggregator A | the federated mean was computed honestly | nothing secret (B/C verify) |

`update_gradient` is the doc's relation **R**; `update_model` is **R_agg**. Together
they make the round trustless both ways: A verifies trainers (anti-T1/T3), B/C verify A.

## Relations

**`update_gradient`** — public `(x, x', commit, y_max)`, private `(y, s)`:

```
commit  = Poseidon(y, s)     // y is bound to a ZK-friendly commitment
x'      = x + y              // correct formula
0 <= y <= y_max              // range-check (anti-T1, anti field-wrap)
```

**`update_model`** — all public `(updates[N], x_new, remainder)`, `N = 2`:

```
sum(updates) = N * x_new + remainder     // Euclidean (division-with-remainder)
0 <= remainder < N
  =>  x_new     = floor(sum / N)
      remainder = sum mod N
```

For `N = 2` this is exactly the doc's `2 * x_new = x' + x''` (`remainder` in `{0,1}`).
This is the doc §3.1.5 answer to the "division in a finite field" open question: a
field has no integer division, so the mean is rewritten with an explicit remainder.

## Build (produces the reusable keys)

```bash
npm run zk:build      # circom compile -> powers of tau -> groth16 setup -> export pk/vk
```

Outputs (the deliverable — generated once, reused for every proof):

```
keys/update_gradient.zkey        proving key      (pk)
keys/update_gradient.vkey.json   verification key (vk)
keys/update_gradient.verifier.sol  Solidity on-chain verifier (bonus)
keys/update_model.zkey  /  .vkey.json  /  .verifier.sol
```

The Powers-of-Tau phase is cached under `ptau/`; delete it to redo phase 1.

## Prove / verify

CLI (uses the saved keys):

```bash
npm run zk:inputs                       # write sample inputs/*.input.json
npm run zk:prove  -- update_gradient    # -> proofs/update_gradient.{proof,public}.json
npm run zk:verify -- update_gradient    # -> verify = true
npm run zk:demo                         # inputs + prove + verify, both circuits
```

Programmatic (TypeScript, from the FL protocol) — [src/d2/index.ts](../src/d2/index.ts):

```ts
import { computeCommit, proveGradient, verifyGradient,
         proveModel, verifyModel, meanWithRemainder } from "./d2/index.ts";

// trainer B: prove x' = x + y without revealing y
const commit = await computeCommit(y, salt);          // Poseidon(y, salt)
const g = await proveGradient({ y, s: salt, x, x_prime: x + y, commit, y_max });
await verifyGradient(g);                                // true

// aggregator A: prove the mean
const { x_new, remainder } = meanWithRemainder([xB, xC]);
const m = await proveModel({ updates: [xB, xC], x_new, remainder });
await verifyModel(m);                                   // true
```

Tests: `npm test` (the `src/d2/zk.test.ts` suite — honest proofs verify, tampered
public signals are rejected, dishonest/out-of-range witnesses cannot be proven).

## Layout

```
circuit/
  src/update_gradient.circom   relation R   (Poseidon commit + add + range-check)
  src/update_model.circom      relation R_agg (mean via division-with-remainder)
  scripts/build.sh             compile + trusted setup + export pk/vk (+solidity)
  scripts/gen-inputs.mjs       sample inputs (computes Poseidon commit)
  scripts/prove.mjs            witness + groth16 prove (saved zkey)
  scripts/verify.mjs           groth16 verify (saved vkey)
  bin/circom                   circom 2.2.3 binary (downloaded)
  keys/                        pk (.zkey) + vk (.vkey.json) + verifier.sol   <- reused
  build/  ptau/  inputs/  proofs/   regenerable artifacts
```

## Design notes (from the doc trade-offs)

- **Poseidon, not SHA-256, for the commitment.** SHA-256 is very expensive inside a
  circuit (§D2); the commit uses ZK-friendly Poseidon. SHA-256 stays in the D1 layer
  (outside the circuit). `computeCommit` uses circomlibjs so the off-circuit value
  matches what the circuit recomputes.
- **Range-check matters even with a valid proof.** A proof only says "the formula
  holds"; without `0 <= y <= y_max` a trainer could submit `y = 10^9` and still prove
  `x' = x + y`. ZKP and range-check are complementary (doc §3.1.5).
- **Groth16 trusted setup.** Small proofs + cheap on-chain verify, at the cost of a
  per-circuit setup with "toxic waste". The ceremony here is a single dev contribution
  (entropy from `/dev/urandom`) — **not** a production ceremony. Changing a circuit
  (formula, range, hash) requires re-running `zk:build` and redistributing the keys
  (doc: "trusted setup theo version").
- **N is fixed at compile time.** `update_model` is compiled for `N = 2` trainers.
  Stage 3 (more trainers) recompiles with a different `N`; `proveModel` guards the count.
- **D2 does not hide `y` from A.** Since `x'` is public and A knows `x`, A computes
  `y = x' - x`. D2 only stops cheating; hiding `y` is D3's job (doc §D2 last note).
```
