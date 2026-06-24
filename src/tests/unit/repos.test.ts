import { test } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "../../model/aggregator.model.ts";
import { Anchor } from "../../model/anchor.model.ts";
import { OffchainRepo } from "../../repo/offchain-repo.ts";
import { OnchainRepo } from "../../repo/onchain-repo.ts";
import { LogRepo } from "../../repo/log-repo.ts";
import { RoundRepo } from "../../repo/round-repo.ts";
import { PartyRepo, seedParties } from "../../repo/party-repo.ts";
import { SessionRepo } from "../../repo/session-repo.ts";
import { SessionMemberRepo } from "../../repo/session-member-repo.ts";
import { PARTIES } from "../../infra/parties.ts";
import { mockRedis } from "../redis-mock.ts";

test("OffchainRepo: put/get round-trips leaves; CID is content-addressed", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const A = new Aggregator("A");
  const leaves = [A.createLeaf({ type: "SEND", session_id: "s", round_id: 1, payload: 1, version: "v1", timestamp: 1 })];
  const repo = new OffchainRepo(redis);

  const cid1 = await repo.put(leaves);
  const cid2 = await repo.put(leaves);
  assert.equal(cid1, cid2);

  const got = await repo.get(cid1);
  assert.equal(got?.length, 1);
  assert.equal(got?.[0].leaf_hash, leaves[0].leaf_hash);
  assert.equal(await repo.get("cid:missing"), undefined);
});

// build a valid signed block: tx_hash derived over the header + signature
function block(prevTx: string | null, root: string, r: number): Anchor {
  const header = { merkle_root: root, cid: "c" + root, batch_id: "b" + r, session_id: "s", round_id: r, timestamp: r, submitter_id: "id-A", previous_tx_hash: prevTx };
  const tx_sig = "sig-" + root;
  return Anchor.from({ ...header, tx_sig, tx_hash: Anchor.txHash(header, tx_sig) });
}

test("OnchainRepo: append / head / get / all (chronological) + verifyChain", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new OnchainRepo(redis);

  const g = block(null, "r1", 1); // genesis
  await repo.append(g);
  const b2 = block(g.tx_hash, "r2", 2); // links to genesis by its tx_hash
  await repo.append(b2);

  assert.equal(await repo.head(), b2.tx_hash);
  assert.match(g.tx_hash, /^tx:sha256:/);
  assert.equal((await repo.get(g.tx_hash))?.merkle_root, "r1"); // key-value lookup by tx_hash
  assert.equal(await repo.get("tx:missing"), undefined);

  const all = await repo.all();
  assert.deepEqual(all.map((a) => a.merkle_root), ["r1", "r2"]); // genesis -> latest
  assert.equal(all[1].previous_tx_hash, g.tx_hash);
  assert.equal((await repo.verifyChain()).ok, true);
});

test("OnchainRepo: verifyChain catches a missing block and a tampered block", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new OnchainRepo(redis);

  // head's block links to a previous_tx_hash that does not exist -> broken chain
  await repo.append(block("tx:sha256:doesnotexist", "r9", 9));
  assert.equal((await repo.verifyChain()).ok, false);

  // tamper a stored block: mutate a field so the recomputed tx_hash no longer matches
  await redis.flushall();
  const g = block(null, "r1", 1);
  await repo.append(g);
  await redis.set(`onchain:${g.tx_hash}`, JSON.stringify({ ...g, merkle_root: "HACKED" }));
  assert.equal((await repo.verifyChain()).ok, false);
});

test("LogRepo: stores the full merkle leaf (id + fields + signature)", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const A = new Aggregator("A", undefined, undefined, "id-A");
  const leaf = A.createLeaf({ type: "SEND", session_id: "sX", round_id: 3, payload: 1, version: "v1", timestamp: 1 });
  const repo = new LogRepo(redis);
  await repo.save(leaf);
  assert.equal(await repo.count(), 1);
  const r = await repo.byRound("sX", 3);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, leaf.id); // leaf's own id
  assert.equal(r[0].fields.party_id, "id-A"); // the user who created the log
  assert.equal(r[0].signature, leaf.signature); // user's signature stored
  assert.equal(r[0].leaf_hash, leaf.leaf_hash); // derived on reconstruction
});

test("LogRepo: id is the primary key — get(id) lookup", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const A = new Aggregator("A", undefined, undefined, "id-A");
  const leaf = A.createLeaf({ type: "SEND", session_id: "sX", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  const repo = new LogRepo(redis);
  await repo.save(leaf);

  const got = await repo.get(leaf.id);
  assert.equal(got?.id, leaf.id);
  assert.equal(got?.leaf_hash, leaf.leaf_hash);
  assert.equal(await repo.get("log-id-does-not-exist"), undefined);
});

test("LogRepo: save is idempotent on id (re-save does not duplicate the row)", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const A = new Aggregator("A", undefined, undefined, "id-A");
  const leaf = A.createLeaf({ type: "SEND", session_id: "sX", round_id: 1, payload: 1, version: "v1", timestamp: 1 });
  const repo = new LogRepo(redis);

  await repo.save(leaf);
  await repo.save(leaf); // retry of the same id

  assert.equal(await repo.count(), 1); // not 2 — no duplicate index entry
  assert.equal((await repo.byRound("sX", 1)).length, 1);
});

test("RoundRepo: counter/model + open round + collected gradients (explicit session)", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new RoundRepo(redis);
  const s = "sX";

  assert.equal(await repo.nextRoundId(s), 1);
  assert.equal(await repo.nextRoundId(s), 2);
  assert.equal(await repo.model(s), null);
  await repo.setModel(107.5, s);
  assert.equal(await repo.model(s), 107.5);

  const A = new Aggregator("A");
  const send = A.createLeaf({ type: "SEND", session_id: s, round_id: 3, payload: 100, version: "v1", timestamp: 1 });
  await repo.openRound({ round_id: 3, session_id: s, send: send.toWire() });
  assert.equal((await repo.current(s))?.round_id, 3);

  const ugB = A.createLeaf({ type: "UPDATE_GRADIENT", session_id: s, round_id: 3, payload: 110, version: "v1", timestamp: 1 });
  await repo.addGradient("B", ugB.toWire(), s);
  assert.equal(await repo.hasGradient("B", s), true);
  assert.equal(await repo.hasGradient("C", s), false);
  const grads = await repo.gradients(s);
  assert.equal(Object.keys(grads).length, 1);
  assert.equal(grads.B.fields.payload, 110);

  await repo.closeRound(s);
  assert.equal(await repo.current(s), null);
  assert.equal(await repo.hasGradient("B", s), false);
});

test("RoundRepo: claimFinalize is a one-time SETNX; setResult/result round-trips", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new RoundRepo(redis);

  // only the first claim for a (session, round) wins — the race guard for finalize
  assert.equal(await repo.claimFinalize("s1", 1), true);
  assert.equal(await repo.claimFinalize("s1", 1), false);
  assert.equal(await repo.claimFinalize("s1", 2), true); // different round, fresh
  assert.equal(await repo.claimFinalize("s2", 1), true); // different session, fresh

  assert.equal(await repo.result("s1", 1), null);
  const result = { round_id: 1, x_new: 107.5, cid: "cid:x", tx_hash: "tx:x" };
  await repo.setResult("s1", 1, result);
  assert.deepEqual(await repo.result("s1", 1), result);
});

test("RoundRepo: two sessions keep independent counter / model / open round", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new RoundRepo(redis);

  // independent round counters
  assert.equal(await repo.nextRoundId("s1"), 1);
  assert.equal(await repo.nextRoundId("s1"), 2);
  assert.equal(await repo.nextRoundId("s2"), 1); // s2 starts fresh, no collision
  assert.equal(await repo.nextRoundId("s2"), 2);

  // independent models
  await repo.setModel(100, "s1");
  await repo.setModel(200, "s2");
  assert.equal(await repo.model("s1"), 100);
  assert.equal(await repo.model("s2"), 200);

  // independent open rounds + gradients
  const A = new Aggregator("A");
  const sendS1 = A.createLeaf({ type: "SEND", session_id: "s1", round_id: 2, payload: 1, version: "v1", timestamp: 1 });
  const sendS2 = A.createLeaf({ type: "SEND", session_id: "s2", round_id: 2, payload: 1, version: "v1", timestamp: 1 });
  await repo.openRound({ round_id: 2, session_id: "s1", send: sendS1.toWire() });
  await repo.openRound({ round_id: 2, session_id: "s2", send: sendS2.toWire() });

  const ugB = A.createLeaf({ type: "UPDATE_GRADIENT", session_id: "s1", round_id: 2, payload: 11, version: "v1", timestamp: 1 });
  await repo.addGradient("B", ugB.toWire(), "s1");
  assert.equal(await repo.hasGradient("B", "s1"), true);
  assert.equal(await repo.hasGradient("B", "s2"), false); // not leaked across sessions

  await repo.closeRound("s1");
  assert.equal(await repo.current("s1"), null);
  assert.equal((await repo.current("s2"))?.round_id, 2); // s2 still open
});

test("PartyRepo: save/get/all/byRef stores public identity only", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new PartyRepo(redis);

  await repo.save({ id: "id-A", name: "A", role: "aggregator", pubKeyRef: "key:aaa", publicKey: "PEM-A" });
  await repo.save({ id: "id-B", name: "B", role: "trainer", pubKeyRef: "key:bbb", publicKey: "PEM-B" });

  assert.equal((await repo.get("id-A"))?.name, "A");
  assert.equal((await repo.get("id-A"))?.role, "aggregator");
  assert.equal(await repo.get("missing"), undefined);
  assert.equal((await repo.all()).length, 2);
  assert.equal((await repo.byRef("key:bbb"))?.id, "id-B");
  assert.equal(await repo.byRef("key:none"), undefined);
});

test("seedParties registers every configured party (public fields only)", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new PartyRepo(redis);

  await seedParties(repo);
  const all = await repo.all();
  assert.deepEqual(all.map((p) => p.name).sort(), ["A", "B", "C"]);

  const a = await repo.get(PARTIES.A.id);
  assert.equal(a?.role, "aggregator");
  assert.ok((a?.pubKeyRef ?? "").length > 0);
  assert.match(a?.publicKey ?? "", /BEGIN PUBLIC KEY/);
  assert.ok(!Object.keys(a ?? {}).some((k) => /private|secret|wallet/i.test(k))); // no secret leaks
});

test("SessionRepo: create/get/all/setStatus round-trips config (numbers parsed)", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new SessionRepo(redis);

  await repo.create({
    session_id: "s1", aggregator_id: "id-A", operation: "+", input_type: "scalar",
    anchor_policy: "per-round", y_max: 1_000_000, version: "v1", status: "open", created_at: 123,
  });

  const got = await repo.get("s1");
  assert.equal(got?.aggregator_id, "id-A");
  assert.equal(got?.y_max, 1_000_000); // parsed back to a number, not "1000000"
  assert.equal(typeof got?.y_max, "number");
  assert.equal(got?.created_at, 123);
  assert.equal(got?.status, "open");
  assert.equal(await repo.get("missing"), undefined);

  await repo.setStatus("s1", "closed");
  assert.equal((await repo.get("s1"))?.status, "closed");
  assert.equal((await repo.all()).length, 1);
});

test("SessionMemberRepo: A+B+C and A+D+E membership (many-to-many)", async () => {
  const redis = mockRedis();
  await redis.flushall();
  const repo = new SessionMemberRepo(redis);

  for (const [pid, role] of [["A", "aggregator"], ["B", "trainer"], ["C", "trainer"]] as const) await repo.add("s1", pid, role);
  for (const [pid, role] of [["A", "aggregator"], ["D", "trainer"], ["E", "trainer"]] as const) await repo.add("s2", pid, role);

  assert.deepEqual((await repo.members("s1")).map((m) => m.party_id).sort(), ["A", "B", "C"]);
  assert.deepEqual((await repo.members("s2")).map((m) => m.party_id).sort(), ["A", "D", "E"]);
  assert.equal((await repo.members("s1")).find((m) => m.party_id === "A")?.role, "aggregator");
  assert.equal((await repo.members("s1")).find((m) => m.party_id === "B")?.role, "trainer");

  // reverse lookup: A is in both groups, B and D each in one
  assert.deepEqual((await repo.sessionsOf("A")).sort(), ["s1", "s2"]);
  assert.deepEqual(await repo.sessionsOf("B"), ["s1"]);
  assert.deepEqual(await repo.sessionsOf("D"), ["s2"]);

  assert.equal(await repo.isMember("s1", "B"), true);
  assert.equal(await repo.isMember("s2", "B"), false);

  // remove drops both directions
  await repo.remove("s1", "B");
  assert.equal(await repo.isMember("s1", "B"), false);
  assert.deepEqual(await repo.sessionsOf("B"), []);
});
