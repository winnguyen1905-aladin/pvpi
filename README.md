# fl-psi — Stage 1 (Scalar)

A TypeScript simulation of the Stage-1 protocol from
*"Blockchain Audit Layer, Federated Learning, Private Set Intersection"*:

> Three parties run a round. Aggregator **A** broadcasts a scalar; trainers **B**/**C**
> verify, compute, and sign their updates; **A** verifies, aggregates, and signs the new
> model; every signed log of the round is batched into a **Merkle tree** whose root is
> anchored "on-chain", hash-linked to the previous batch.

The code is organised as a layered, OOP backend: **router** (HTTP API), **service**
(business logic), **model** (domain classes), **repo** (Redis persistence), with **infra**
(redis, config), **utils** (crypto, http-client), and **app** (composition roots) around them.

## Layers

```
src/
  infra/    redis (ioredis client + shared singleton), config/ports,
            parties (fixed ed25519 keys for A/B/C + stable id + role + secrets)
  utils/    stateless helpers: crypto (sha256 / canonicalize / randomUUID), http-client (postJson / closeServer)
  types/    identity + plain shapes (supporting, not persisted records): Ed25519Key, KeyRegistry,
            Wallet (anchor-tx signer), log (LogFields/WireLeaf/CreateLeafArgs),
            sim (SimConfig/RoundMeta/AnchorFields),
            verify (VerifyResult/ExpectedContext/ProofStep/PublicKeyLookup/Verifier)
  model/    entities that get saved (on-chain / off-chain / db), each named *.model.ts:
            merkle-leaf (off-chain leaf), anchor (on-chain), merkle-tree, and Party split per role:
            party.model.ts (base Party + id), aggregator.model.ts (+ Wallet), trainer.model.ts (+ secret)
  repo/     OffchainRepo, OnchainRepo, PartyRepo, LogRepo — Redis-backed; each exports a singleton
  service/  AggregatorService (A: runRound — broadcast / collect gradients / aggregate + anchor),
            TrainerService (B/C: onBroadcast — verify A, compute, push gradient) — stateless
  router/   agg-router, trainer-router — Express routers mapping paths to handlers
  app/      factory (config keys + singleton repos → services → router), repl
  tests/    unit/ (model, repo, service on ioredis-mock) + automation/ (full round over HTTP)
  main.ts   role-based express server:  node src/main.ts agg | trainer <B|C>
```

A **model is a model, not a workflow**: a `Party` only holds identity + authors signed leaves;
the round operations (broadcast / aggregate / handleSend / anchor) live in **services**, which
use the **repos** for persistence.

## Redis

The repos persist to a real Redis server — Redis is the database for off-chain leaf batches,
on-chain anchor transactions, and the per-leaf logs.

Start one with Docker Compose ([docker-compose.yml](docker-compose.yml) runs `redis:7-alpine` on
`:6379` with an append-only volume):

```bash
npm run redis:up      # docker compose up -d   (use REDIS_PORT=6380 npm run redis:up if 6379 is taken)
npm run redis:down    # docker compose down
```

- Default: real `ioredis` to `REDIS_URL` (default `redis://127.0.0.1:6379`; e.g. `REDIS_URL=redis://127.0.0.1:6380` to match a custom `REDIS_PORT`).
- `REDIS_MOCK=1` swaps in an in-memory `ioredis-mock` (no server) — a dev/demo convenience.
- The test suite always uses `ioredis-mock`, so `npm test` needs no server.
- Inspect the state: `docker exec fl-psi-redis redis-cli keys '*'` → `offchain:<cid>`, `onchain:<tx_hash>`
  (one per anchored transaction), `onchain:head` (latest tx_hash), `log:*`, and `round:*` (the in-flight round).

## Run

Needs Node ≥ 22.6 (built-in TypeScript type-stripping — no `tsc`, no `ts-node`).

```bash
npm test                 # unit + automation (ioredis-mock, no server needed)
npm run typecheck        # tsc --noEmit
npm run redis:up         # start Redis (Docker); then run the role servers (see below)
```

[src/main.ts](src/main.ts) is one role-based entry taking **role + name**: `node src/main.ts agg`
runs the aggregator (A), `node src/main.ts trainer B` (or `C`) runs a trainer. Identities (ed25519
keys) are fixed in [src/infra/parties.ts](src/infra/parties.ts), so every party already trusts the
others (no handshake) — only the **addresses** are dynamic (see below).

## Topology: push-star (A broadcasts, B/C push back)

All three are HTTP servers. **B/C** expose `POST /api/model/x` (receive A's broadcast); **A** exposes
`POST /api/gradient` (receive gradients). Every request carries an `x-party: A|B|C` header naming the
sender; the receiver cross-checks it against the Ed25519 signer in the leaf (`leaf.fields.actor`), so the
header is a transport label, not a trust replacement — leaves are still signed and verified.

A drives a round (`round [x]`):

1. A signs `SEND(x)`, stores it as the in-flight round (Redis, via `RoundRepo`), and **broadcasts** it in
   parallel: `POST B|C /api/model/x` (header `x-party: A`).
2. Each trainer verifies A's SEND, computes its `UPDATE_GRADIENT` (`x' = x OP secret`), and **pushes** it
   back: `POST A /api/gradient` (header `x-party: B|C` → `depositGradient` stores it).
3. After the broadcast settles (gradients now collected), A **aggregates** into `UPDATE_MODEL`, anchors the
   batch (off-chain + on-chain + logs), updates the model, and closes the round.

A aggregates once, after the broadcast — so the parallel pushes don't race. Services are stateless: A's
in-flight round (open SEND + collected gradients + current model) lives in Redis (`round:*`).

## Multi-process demo (3 parties over HTTP)

Open **three terminals** (each process is interactive — drive it by typing commands):

```bash
npm run redis:up              # start Redis once (Docker)
npm run agg                   # aggregator A on :3001
npm run net:b                 # trainer B on :3002 (secret y = 10)
npm run net:c                 # trainer C on :3003 (secret z = 5)
```

`npm run agg` = `main agg` (name defaults to A); `npm run net:b` / `net:c` = `main trainer B` / `C`.
Only A/B/C exist (fixed); ports overridable with `AGG_PORT` / `TRAINER_PORTS`.

The round is driven entirely from **A**; B/C auto-respond to the broadcast:

```
# A:                                  # B / C:
round 100   # one round, x = 100       secret <n>   # change the local secret
round       # next round, x = model    status       # role / secret / aggregator
status      # current model x
```

`round` with no arg reuses the current model. Each party's console activity log uses
`[timestamp][from][to] - content` (e.g. `[…][A][B] - SEND x=100`, `[…][B][A] - UPDATE_GRADIENT x'=110`,
`[…][A][chain] - anchor tx=…`). With a real Redis you can inspect: `redis-cli keys '*'` shows
`offchain:<cid>`, `onchain:<tx_hash>`, `onchain:head`, `log:*`, and the in-flight `round:*`.

Notes:
- Run the processes in **real terminals**: each reads stdin for its REPL, so a closed/redirected stdin
  (backgrounding with `&`) makes the process exit on EOF (Ctrl-D / `quit` quit on purpose).
- The whole flow is also covered headlessly by [src/tests/automation/round-e2e.test.ts](src/tests/automation/round-e2e.test.ts)
  (A broadcasts, B/C push back, over real localhost HTTP; repos on ioredis-mock).

## Presentation UI ([web/](web/))

A static landing page that answers five questions (emit / store / view / immutability / resources) and runs a
**live simulation against the real backend** — stepping through every action with its mechanism, log line and
leaf, showing each party's Ed25519 keypair, and a tamper check that recomputes hashes/signatures in the browser.

Each party exposes `GET /api/identity`; A also exposes a small UI API ([src/router/ui-router.ts](src/router/ui-router.ts)):
`POST /api/session`, `POST /api/session/:id/round` (returns the round result + leaves + anchor + A's activity
lines), `GET /api/sessions` / `logs/:s/:r` / `onchain` / `offchain/:cid`. CORS is enabled on all three.

Run it (2 commands — `npm run web` boots A, B, C **and** the page server in one terminal):
```bash
npm run redis:up                 # Redis (detached Docker — returns immediately)
npm run web                      # A + B + C (headless) + web/ on http://localhost:8080 ; Ctrl-C stops all
```
Open **http://localhost:8080** (a modern browser — Web Crypto needs the http://localhost secure context),
**Connect**, **Create session**, **Run round**, then step through.

`npm run web` runs A/B/C **headless** (`NO_REPL=1`, no REPL) because the round is driven from the page over
HTTP. Prefer the REPLs? Run `npm run agg` / `net:b` / `net:c` / `present` in separate terminals instead.

On this box ports 3002/6379/8080 may be taken, so:
```bash
REDIS_PORT=6381 npm run redis:up
REDIS_URL=redis://127.0.0.1:6381 AGG_PORT=4101 TRAINER_PORTS=4102,4103 PRESENT_PORT=8088 npm run web
```
then set the page's **Endpoints** to `:4101/:4102/:4103`.

## The round flow (doc §1 / §3.1.3)

| Step | Actor | Action | Log produced |
|------|-------|--------|--------------|
| B1 | A | broadcast `x` to B, C (`POST /api/model/x`) | `SEND` (A signs) |
| B2 | B / C | verify A, compute `x' = x OP secret` | `UPDATE_GRADIENT` (B/C sign) |
| B3 | B / C | push the gradient back to A (`POST /api/gradient`) | — (the B2 leaf) |
| B4 | A | verify each gradient, aggregate `x_new = mean(updates)` | `UPDATE_MODEL` (A signs) |
| B5 | A | batch all leaves → Merkle tree → off-chain (cid) → on-chain anchor | anchor object |

`SEND` only logs (B3 RECEIVE never logs — the receiver just verifies the signature before
using a value). Aggregation is the mean; the division-by-n is the case the doc flags
(§3.1.5), rewritten in a ZK circuit as the multiplication constraint `n · x_new = Σ updates`.

## Domain types

- **MerkleLeaf** ([src/model/merkle-leaf.model.ts](src/model/merkle-leaf.model.ts)) — a signed log leaf. Built
  from `(fields, signature, id?)`: a `Party` assembles the Table 1 content `fields` (including
  `party_id`, the author's stable id, so it is covered by the signature), signs
  `MerkleLeaf.innerHash(fields)`, then hands both to the class, which derives:
  - `inner_hash = SHA256(canonical(fields))` — the bytes that are signed.
  - `leaf_hash = SHA256(0x00 ‖ canonical(fields + signature))` — the Merkle leaf
    (`0x00` / `0x01` domain separation between leaves and internal nodes).
  - `id` — a per-leaf UUID for reference (defaults to `randomUUID()`); **not signed and not in
    the hashes**, so the root stays content-committed. It travels on the wire (`WireLeaf.id`).

  A leaf verifies itself with `leaf.verify(lookup, expected?)`; hashes are re-derived on
  construction, so a tampered field surfaces as a failed signature check (and a diverged root).
  The **log** collection (`log:*`) stores each leaf as the full `WireLeaf { id, fields, signature }` —
  the leaf's `fields` IS the log object, and `fields.party_id` is the user who created it.
- **Anchor** ([src/model/anchor.model.ts](src/model/anchor.model.ts)) — a signed on-chain transaction
  (Table 3). Header: `merkle_root`, `cid`, `batch_id`, `round_id`, `timestamp`, `submitter_id` (the user id
  of the party that anchored the block), `previous_tx_hash` (null on the genesis block). The aggregator
  wallet signs the header (`tx_sig`), and `tx_hash = SHA256(canonical(header + tx_sig))` content-addresses
  the signed tx (the on-chain mirror of the off-chain `cid`). Stored key-value as `onchain:<tx_hash>`; blocks
  chain via `previous_tx_hash`. `Anchor.isIntact()` recomputes `tx_hash` to detect tampering.
- **Config** (`SimConfig`, [src/types/sim.ts](src/types/sim.ts)) — §1 generic config:
  `{ input_type, operation, parties, rounds, anchor_policy, version, y_max }`.

## What the audit layer catches (doc §6)

- **Forged sender / repudiation** — every log is Ed25519-signed; `leaf.verify(...)` rejects a
  bad signature or any mutated field.
- **Edited payload / round / replayed update** — `round_id` is inside the signed content, and the
  anchored root diverges from any altered off-chain leaf set.
- **Dropped / reordered / tampered batch** — each on-chain block links to the prior by `previous_tx_hash`,
  and `tx_hash` covers the whole signed block; `OnchainRepo.verifyChain` walks head→genesis, recomputing
  `tx_hash` (catches edits) and following the links (catches a missing/forked block).

`MerkleLeaf.verify` enforces three layers: (1) **crypto integrity** — signature over `inner_hash`;
(2) **schema invariant** — `input_refs` present iff `type === UPDATE_MODEL`; (3) **context binding**
(optional) — signed `session_id` / `round_id` / `type` / `actor` must match the current step, so an
old, still-validly-signed update can't be replayed.

## Conventions

- **`inner_hash` / `leaf_hash` are derived, not stored.** A `MerkleLeaf` holds `fields` + `signature`
  and re-derives both hashes in its constructor (Table 2), never hashed into themselves
  ([src/model/merkle-leaf.model.ts](src/model/merkle-leaf.model.ts) `MerkleLeaf.innerHash` / `MerkleLeaf.leafHash`).
- **`idempotency_key` is derived, not random.**
  `idempotency_key = "idem:" + SHA256(session_id | round_id | actor | type | seq)[:24]`
  ([src/model/party.model.ts](src/model/party.model.ts) `Party.deriveIdempotencyKey`).
- **Merkle odd-leaf rule: promote, don't duplicate.** A level with an odd node count carries the lone
  node up unchanged ([src/model/merkle-tree.model.ts](src/model/merkle-tree.model.ts)), avoiding the CVE-2012-2459
  duplicate-leaf root collision. Proofs verify for any leaf count (the test covers n = 1, 2, 3, 4, 5, 7).

## Open question (for doc §3.1.6)

Stage-1 aggregation is `x_new = Σ/n` in plain JS, so an odd sum gives a real float (round 1 uses
`secret z = 5` → mean `107.5`). In a ZK circuit there is no integer division: the mean becomes the
constraint `n · x_new = Σ updates`, which for `2·x_new = 215` has no integer solution. Decision
needed: fixed-point scale, round, or carry a remainder `0 ≤ r < n`. Zero denominator is forbidden.
# pvpi
