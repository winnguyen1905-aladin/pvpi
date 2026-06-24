import { test } from "node:test";
import assert from "node:assert/strict";
import { partyConfig, portOf } from "../../infra/parties.ts";
import { redis } from "../../infra/redis.ts";
import { onchainRepo } from "../../repo/onchain-repo.ts";
import { logRepo } from "../../repo/log-repo.ts";
import { roundRepo } from "../../repo/round-repo.ts";
import { createAggregatorNode, createTrainerNode } from "../../app/factory.ts";
import { closeServer } from "../../utils/http-client.ts";

const silent = (_m: string) => {};

// Needs REDIS_MOCK=1 (set by the npm test script). Push-star: A, B, C are all servers.
// A `runRound` broadcasts SEND -> trainers verify + compute + push gradient -> A
// aggregates. One process / one set of servers, exercising two sessions over them (the
// servers are not restarted between scenarios, so fetch never reuses a pooled socket to
// a closed port).
test("push-star multi-session: independent sessions over shared B/C servers", async () => {
  await redis.flushall();

  const A = createAggregatorNode({ log: silent });
  const B = createTrainerNode({ name: "B", log: silent });
  const C = createTrainerNode({ name: "C", log: silent });
  const sA = A.listen(portOf("A"));
  const sB = B.listen(portOf("B"));
  const sC = C.listen(portOf("C"));

  try {
    // session s1 = A + B + C, two rounds
    const s1 = (await A.svc.createSession(["B", "C"])).session_id;
    const r1 = await A.svc.runRound(s1, 100); // B->110, C->105; mean 107.5
    assert.equal(r1.round_id, 1);
    assert.equal(r1.x_new, 107.5);
    const r2 = await A.svc.runRound(s1); // default x=107.5 -> 117.5, 112.5 -> mean 115
    assert.equal(r2.x_new, 115);
    assert.equal(await A.svc.model(s1), 115);

    // on-chain: 2 hash-linked blocks anchored by A; round closed after each
    let chain = await onchainRepo.all();
    assert.equal(chain.length, 2);
    assert.equal(chain[1].previous_tx_hash, chain[0].tx_hash);
    assert.equal(chain[0].submitter_id, partyConfig("A").id);
    assert.equal((await onchainRepo.verifyChain()).ok, true);
    assert.equal(await roundRepo.current(s1), null); // no round left open

    // logs: round 1 has 4 leaves (SEND, UG_B, UG_C, MODEL); B's gradient maps to user B
    assert.equal(await logRepo.count(), 8); // 2 rounds x 4 leaves
    const logged = await logRepo.byRound(s1, 1);
    assert.equal(logged.length, 4);
    assert.ok(logged.every((l) => l.signature.length > 0));
    assert.ok(logged.some((l) => l.fields.party_id === partyConfig("B").id));

    // session s2 = A + B only: different membership => threshold 1, mean over just B
    const s2 = (await A.svc.createSession(["B"])).session_id;
    const r3 = await A.svc.runRound(s2, 50); // only B->60
    assert.equal(r3.round_id, 1); // s2 has its own counter, not continuing s1
    assert.equal(r3.x_new, 60);

    // independence: s1 untouched, s2 holds its own model; one extra anchor on the chain
    assert.equal(await A.svc.model(s1), 115);
    assert.equal(await A.svc.model(s2), 60);
    chain = await onchainRepo.all();
    assert.equal(chain.length, 3);
  } finally {
    await Promise.all([closeServer(sA), closeServer(sB), closeServer(sC)]);
  }
});
