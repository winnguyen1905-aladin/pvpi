import { test } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "../../model/aggregator.model.ts";
import { Trainer } from "../../model/trainer.model.ts";
import { buildRegistry, loadKey, partyConfig } from "../../infra/parties.ts";
import { KeyRegistry } from "../../types/key-registry.ts";
import type { RoundMeta, SimConfig } from "../../types/sim.ts";
import { OffchainRepo } from "../../repo/offchain-repo.ts";
import { OnchainRepo } from "../../repo/onchain-repo.ts";
import { LogRepo } from "../../repo/log-repo.ts";
import { RoundRepo } from "../../repo/round-repo.ts";
import { SessionRepo } from "../../repo/session-repo.ts";
import { SessionMemberRepo } from "../../repo/session-member-repo.ts";
import { AggregatorService } from "../../service/aggregator-service.ts";
import { TrainerService } from "../../service/trainer-service.ts";
import { mockRedis } from "../redis-mock.ts";

const cfg: SimConfig = {
  input_type: "scalar",
  operation: "+",
  parties: { aggregator: "A", trainers: ["B", "C"] },
  rounds: 1,
  anchor_policy: "per-round",
  version: "v1",
  y_max: 1_000_000,
};

function meta(round = 1): RoundMeta {
  return { config: cfg, session_id: "s1", round_id: round, now: () => 1 };
}

function aggService(reg: KeyRegistry, A: Aggregator): AggregatorService {
  const redis = mockRedis();
  return new AggregatorService({
    aggregator: A,
    registry: reg,
    offchain: new OffchainRepo(redis),
    onchain: new OnchainRepo(redis),
    logs: new LogRepo(redis),
    round: new RoundRepo(redis),
    sessions: new SessionRepo(redis),
    members: new SessionMemberRepo(redis),
  });
}

test("TrainerService.applyOp covers ops and forbids division by zero", () => {
  assert.equal(TrainerService.applyOp("+", 100, 10), 110);
  assert.equal(TrainerService.applyOp("-", 100, 10), 90);
  assert.equal(TrainerService.applyOp("*", 100, 10), 1000);
  assert.equal(TrainerService.applyOp("/", 100, 10), 10);
  assert.throws(() => TrainerService.applyOp("/", 100, 0), /division by zero/);
});

test("handleSend + aggregate produce the mean (107.5) and anchor over Redis repos", async () => {
  const reg = new KeyRegistry();
  const A = new Aggregator("A");
  const B = new Trainer("B", 10);
  const C = new Trainer("C", 5);
  for (const p of [A, B, C]) reg.register(p.key);

  const agg = aggService(reg, A);
  const m = meta();
  const send = agg.broadcast(100, m);
  const grads = [new TrainerService(B, reg).handleSend(send, m), new TrainerService(C, reg).handleSend(send, m)];
  assert.deepEqual(grads.map((l) => l.fields.payload), [110, 105]);

  const { modelLeaf, x_new } = agg.aggregate(grads, [B.pubKeyRef, C.pubKeyRef], m);
  assert.equal(x_new, 107.5);
  assert.deepEqual(modelLeaf.fields.input_refs, grads.map((l) => l.leaf_hash));
  assert.equal(modelLeaf.verify(reg).ok, true);

  const { cid, anchor } = await agg.anchorBatch([send, ...grads, modelLeaf], m);
  assert.match(cid, /^cid:sha256:/);
  assert.equal(anchor.previous_tx_hash, null); // genesis block
  assert.match(anchor.tx_hash, /^tx:sha256:/); // on-chain tx id, like the off-chain cid
  assert.equal(anchor.submitter_id, "A"); // the aggregator that anchored (its user id)
  assert.equal(anchor.isIntact(), true); // tx_hash matches the signed content
});

test("depositGradient: takes session/round from the request, scoped to that session", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const round = new RoundRepo(redis);
  // configured keys so the gradient's actor matches refOf("B") inside the validator
  const A = new Aggregator("A", loadKey("A"), undefined, partyConfig("A").id);
  const svc = new AggregatorService({
    aggregator: A,
    registry: buildRegistry(),
    offchain: new OffchainRepo(redis),
    onchain: new OnchainRepo(redis),
    logs: new LogRepo(redis),
    round,
    sessions: new SessionRepo(redis),
    members: new SessionMemberRepo(redis),
    log: () => {},
  });
  const sid = (await svc.createSession(["B", "C"])).session_id; // UUID, trainers B,C

  const send = A.createLeaf({ type: "SEND", session_id: sid, round_id: 1, payload: 100, version: "v1", timestamp: 1 });
  await round.openRound({ round_id: 1, session_id: sid, send: send.toWire() });

  const B = new Trainer("B", 10, loadKey("B"), partyConfig("B").id);
  const grad = B.createLeaf({ type: "UPDATE_GRADIENT", session_id: sid, round_id: 1, payload: 110, version: "v1", timestamp: 1 });

  // matching session + round -> stored under that session
  assert.deepEqual(await svc.depositGradient("B", sid, 1, grad.toWire()), { ok: true });
  assert.equal(await round.hasGradient("B", sid), true);

  // wrong round for the open session -> rejected by the scoped guard
  assert.equal((await svc.depositGradient("B", sid, 2, grad.toWire())).ok, false);

  // an unknown session with no open round -> rejected (no fallback to a global round)
  const r = await svc.depositGradient("B", "no-such-session", 1, grad.toWire());
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /no round open for this session/);
});

test("depositGradient finalizes the round when the last gradient completes the set", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const round = new RoundRepo(redis);
  const onchain = new OnchainRepo(redis);
  const A = new Aggregator("A", loadKey("A"), undefined, partyConfig("A").id);
  const svc = new AggregatorService({
    aggregator: A,
    registry: buildRegistry(),
    offchain: new OffchainRepo(redis),
    onchain,
    logs: new LogRepo(redis),
    round,
    sessions: new SessionRepo(redis),
    members: new SessionMemberRepo(redis),
    log: () => {},
  });
  const sid = (await svc.createSession(["B", "C"])).session_id; // UUID, trainers B,C

  const send = A.createLeaf({ type: "SEND", session_id: sid, round_id: 1, payload: 100, version: "v1", timestamp: 1 });
  await round.openRound({ round_id: 1, session_id: sid, send: send.toWire() });

  const B = new Trainer("B", 10, loadKey("B"), partyConfig("B").id);
  const C = new Trainer("C", 5, loadKey("C"), partyConfig("C").id);
  const gB = B.createLeaf({ type: "UPDATE_GRADIENT", session_id: sid, round_id: 1, payload: 110, version: "v1", timestamp: 1 });
  const gC = C.createLeaf({ type: "UPDATE_GRADIENT", session_id: sid, round_id: 1, payload: 105, version: "v1", timestamp: 1 });

  // first gradient (B): stored but NOT finalized — round still open, nothing anchored
  assert.deepEqual(await svc.depositGradient("B", sid, 1, gB.toWire()), { ok: true });
  assert.notEqual(await round.current(sid), null);
  assert.equal(await round.model(sid), null);
  assert.equal((await onchain.all()).length, 0);

  // second gradient (C) completes the set -> finalize: mean 107.5, anchored, round closed
  assert.deepEqual(await svc.depositGradient("C", sid, 1, gC.toWire()), { ok: true });
  assert.equal(await round.model(sid), 107.5);
  assert.equal(await round.current(sid), null); // closed
  const chain = await onchain.all();
  assert.equal(chain.length, 1);
  assert.deepEqual(await round.result(sid, 1), { round_id: 1, x_new: 107.5, cid: chain[0].cid, tx_hash: chain[0].tx_hash });

  // a late re-deposit after finalize is rejected (round closed) and does not double-anchor
  const late = await svc.depositGradient("C", sid, 1, gC.toWire());
  assert.equal(late.ok, false);
  assert.match(late.reason ?? "", /no round open/);
  assert.equal((await onchain.all()).length, 1);
});

test("range-check rejects a secret above y_max", () => {
  const reg = new KeyRegistry();
  const A = new Aggregator("A");
  const B = new Trainer("B", 5_000_000);
  reg.register(A.key);
  reg.register(B.key);
  const send = aggService(reg, A).broadcast(100, meta());
  assert.throws(() => new TrainerService(B, reg).handleSend(send, meta()), /range-check failed/);
});

test("aggregate rejects a zero-trainer round (divide-by-zero denominator)", () => {
  const reg = new KeyRegistry();
  const A = new Aggregator("A");
  reg.register(A.key);
  assert.throws(() => aggService(reg, A).aggregate([], [], meta()), /denominator .*zero|trainer count.*zero/);
});
