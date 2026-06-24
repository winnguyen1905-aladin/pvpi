import { canonicalize, randomUUID, sha256hex } from "../utils/crypto.ts";
import { postJson, short } from "../utils/http-client.ts";
import { logLine } from "../utils/log.ts";
import { CONFIG, START_X } from "../infra/config.ts";
import { peerOf, refOf, partyConfig, trainerPeers } from "../infra/parties.ts";
import type { Peer } from "../infra/parties.ts";
import { Aggregator } from "../model/aggregator.model.ts";
import { MerkleLeaf } from "../model/merkle-leaf.model.ts";
import { MerkleTree } from "../model/merkle-tree.model.ts";
import { KeyRegistry } from "../types/key-registry.ts";
import { Anchor } from "../model/anchor.model.ts";
import type { RoundMeta, AnchorHeader, RoundResult } from "../types/sim.ts";
import type { OffchainRepo } from "../repo/offchain-repo.ts";
import type { OnchainRepo } from "../repo/onchain-repo.ts";
import type { LogRepo } from "../repo/log-repo.ts";
import type { RoundRepo, OpenRound } from "../repo/round-repo.ts";
import type { SessionRepo, SessionMeta } from "../repo/session-repo.ts";
import type { SessionMemberRepo } from "../repo/session-member-repo.ts";

type Logger = (m: string) => void;

export interface AggregatorDeps {
  aggregator: Aggregator;
  registry: KeyRegistry;
  offchain: OffchainRepo;
  onchain: OnchainRepo;
  logs: LogRepo;
  round: RoundRepo;
  sessions: SessionRepo;
  members: SessionMemberRepo;
  log?: Logger;
}

export interface AnchorResult {
  tree: MerkleTree;
  cid: string;
  anchor: Anchor;
  tx_sig: string;
}

// Aggregator A — drives a round (push-star). Stateless: the in-flight round (open SEND
// + collected gradients) lives in Redis (RoundRepo); the ledger in the off/on-chain +
// log repos. A broadcasts the SEND to B/C (POST /api/model/:session_id/:round_id); each trainer pushes its
// gradient back (POST /api/gradient -> depositGradient). A aggregates + anchors after
// the broadcast settles.
export class AggregatorService {
  private aggregator: Aggregator;
  private registry: KeyRegistry;
  private offchain: OffchainRepo;
  private onchain: OnchainRepo;
  private logs: LogRepo;
  private round: RoundRepo;
  private sessions: SessionRepo;
  private members: SessionMemberRepo;
  private log: Logger;

  constructor(deps: AggregatorDeps) {
    this.aggregator = deps.aggregator;
    this.registry = deps.registry;
    this.offchain = deps.offchain;
    this.onchain = deps.onchain;
    this.logs = deps.logs;
    this.round = deps.round;
    this.sessions = deps.sessions;
    this.members = deps.members;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  // --- session lifecycle (explicit; no global "active session") ---

  // Create a session (training group): mint a short id (s1, s2, …), record it plus its
  // trainer members. Config (operation/y_max/version) is copied from the global CONFIG.
  async createSession(trainerNames: string[]): Promise<SessionMeta> {
    if (trainerNames.length === 0) throw new Error("a session needs at least one trainer");
    for (const name of trainerNames) {
      if (partyConfig(name).role !== "trainer") throw new Error(`'${name}' is not a trainer`);
    }
    const session_id = randomUUID();
    const meta: SessionMeta = {
      session_id,
      aggregator_id: this.aggregator.name,
      operation: CONFIG.operation,
      input_type: CONFIG.input_type,
      anchor_policy: CONFIG.anchor_policy,
      y_max: CONFIG.y_max,
      version: CONFIG.version,
      status: "open",
      created_at: Date.now(),
    };
    await this.sessions.create(meta);
    await this.members.add(session_id, this.aggregator.name, "aggregator");
    for (const name of trainerNames) await this.members.add(session_id, name, "trainer");
    return meta;
  }

  // Sessions with their trainers + current model x, for display.
  async listSessions(): Promise<Array<{ session_id: string; trainers: string[]; model: number | null; status: string }>> {
    const out: Array<{ session_id: string; trainers: string[]; model: number | null; status: string }> = [];
    for (const s of await this.sessions.all()) {
      const trainers = (await this.members.members(s.session_id))
        .filter((m) => m.role === "trainer")
        .map((m) => m.party_id);
      out.push({ session_id: s.session_id, trainers, model: await this.round.model(s.session_id), status: s.status });
    }
    return out;
  }

  // The trainer peers (url + ref) of a session — the single source for who A broadcasts
  // to and how many gradients a round must collect before it finalizes.
  private async sessionTrainerPeers(session_id: string): Promise<Peer[]> {
    const members = await this.members.members(session_id);
    return members.filter((m) => m.role === "trainer").map((m) => peerOf(m.party_id));
  }

  // Run one round for a session: sign SEND, broadcast it to the session's trainers (POST
  // /api/model/:session_id/:round_id). Each trainer computes + pushes its gradient back
  // (depositGradient), which finalizes the round once the set is complete; then read the
  // stashed result.
  async runRound(session_id: string, x?: number): Promise<RoundResult> {
    if (!(await this.sessions.get(session_id))) throw new Error(`unknown session '${session_id}'`);
    const peers = await this.sessionTrainerPeers(session_id);
    if (peers.length === 0) throw new Error(`session '${session_id}' has no trainers`);

    const round_id = await this.round.nextRoundId(session_id);
    const model = (await this.round.model(session_id)) ?? START_X;
    const useX = x ?? model;
    const meta: RoundMeta = { config: CONFIG, session_id, round_id, now: Date.now };
    const send = this.broadcast(useX, meta);
    await this.round.openRound({ round_id, session_id, send: send.toWire() });

    const me = this.aggregator.name;
    await Promise.all(
      peers.map((p) =>
        postJson(`${p.url}/api/model/${encodeURIComponent(session_id)}/${round_id}`, { leaf: send.toWire() }, { "x-party": me })
          .then(() => this.log(logLine(me, p.name, `SEND x=${useX} ${short(send.leaf_hash)}`)))
          .catch((e: any) => this.log(logLine(me, p.name, `broadcast failed: ${e?.message ?? e}`))),
      ),
    );

    // The gradient push is synchronous (the broadcast above does not resolve until each
    // trainer has posted its gradient back to A), so by here the deposit that completed
    // the set has already run finalizeRound. Read the stashed outcome; if it is absent,
    // not every expected gradient arrived.
    const result = await this.round.result(session_id, round_id);
    if (!result) {
      const have = Object.keys(await this.round.gradients(session_id)).length;
      throw new Error(`round ${round_id}: incomplete, only ${have}/${peers.length} gradients received`);
    }
    return result;
  }

  async depositGradient(
    sender: string,
    session_id: string,
    round_id: number,
    wireLeaf: unknown,
  ): Promise<{ ok: boolean; reason?: string }> {
    const cur = await this.round.current(session_id); // scoped by the request's session, not global
    if (!cur) return { ok: false, reason: "no round open for this session" };
    if (cur.round_id !== round_id) return { ok: false, reason: "gradient is for a different round" };

    const peers = await this.sessionTrainerPeers(session_id);
    if (!peers.some((p) => p.name === sender)) return { ok: false, reason: "sender is not a member of this session" };

    const res = validateDepositGradient({ sender, wireLeaf, session_id, round_id, registry: this.registry });
    if (!res.ok) return { ok: false, reason: res.reason };

    await this.round.addGradient(sender, res.leaf.toWire(), session_id);
    this.log(logLine(sender, this.aggregator.name, `UPDATE_GRADIENT payload=${res.leaf.fields.payload}`));

    // Passive trigger: count the UPDATE_GRADIENT leaves collected for this (session,
    // round). Once every expected one (the session's trainers) is in, the deposit that
    // completes the set finalizes the round (aggregate + anchor); the others just return.
    const grads = await this.round.gradients(session_id);
    if (Object.keys(grads).length < peers.length) return { ok: true }; // not enough yet
    if (!(await this.round.claimFinalize(session_id, round_id))) return { ok: true }; // another deposit finalizes
    await this.finalizeRound(session_id, round_id, cur);
    return { ok: true };
  }

  // Finalize a complete round: aggregate the collected gradients into a new model leaf,
  // anchor the batch, persist the new model + result, then close the round. Triggered by
  // the deposit that completes the gradient set (depositGradient), not by runRound.
  private async finalizeRound(session_id: string, round_id: number, cur: OpenRound): Promise<RoundResult> {
    const meta: RoundMeta = { config: CONFIG, session_id, round_id, now: Date.now };
    const send = MerkleLeaf.fromWire(cur.send);
    const peers = await this.sessionTrainerPeers(session_id);
    const grads = await this.round.gradients(session_id);
    const gradLeaves = peers.map((p) => grads[p.name]).filter((g): g is MerkleLeaf => g !== undefined);
    const refs = peers.map((p) => p.ref);
    const { modelLeaf, x_new } = this.aggregate(gradLeaves, refs, meta);
    const { cid, anchor } = await this.anchorBatch([send, ...gradLeaves, modelLeaf], meta);
    await this.round.setModel(x_new, session_id);
    const result: RoundResult = { round_id, x_new, cid, tx_hash: anchor.tx_hash };
    await this.round.setResult(session_id, round_id, result);
    await this.round.closeRound(session_id);
    const me = this.aggregator.name;
    this.log(logLine(me, me, `aggregate ${gradLeaves.length} -> x_new=${x_new} (round ${round_id})`));
    this.log(logLine(me, "chain", `anchor tx=${short(anchor.tx_hash, 20)} root=${short(anchor.merkle_root)}`));
    return result;
  }

  // A session's current model x (defaults to START_X before any round).
  async model(session_id: string): Promise<number> {
    return (await this.round.model(session_id)) ?? START_X;
  }

  // --- pure protocol ops (B1 / B4 / B5), reused above and by tests ---

  broadcast(x: number, meta: RoundMeta): MerkleLeaf {
    return this.aggregator.createLeaf({
      type: "SEND",
      session_id: meta.session_id,
      round_id: meta.round_id,
      payload: x,
      version: meta.config.version,
      timestamp: meta.now(),
    });
  }

  aggregate(
    gradientLeaves: MerkleLeaf[],
    trainerRefs: string[],
    meta: RoundMeta,
  ): { modelLeaf: MerkleLeaf; x_new: number } {
    for (const leaf of gradientLeaves) {
      const v = leaf.verify(this.registry, {
        session_id: meta.session_id,
        round_id: meta.round_id,
        type: "UPDATE_GRADIENT",
        actors: trainerRefs,
      });
      if (!v.ok) {
        throw new Error(`aggregator rejected gradient leaf: ${v.reason}`);
      }
    }
    if (gradientLeaves.length === 0) {
      throw new Error("mean aggregation denominator (trainer count) is zero — forbidden (D2 §3.1.5)");
    }
    const updates = gradientLeaves.map((l) => l.fields.payload as number);
    const x_new = updates.reduce((s, u) => s + u, 0) / updates.length;
    const modelLeaf = this.aggregator.createLeaf({
      type: "UPDATE_MODEL",
      session_id: meta.session_id,
      round_id: meta.round_id,
      payload: x_new,
      version: meta.config.version,
      timestamp: meta.now(),
      input_refs: gradientLeaves.map((l) => l.leaf_hash),
    });
    return { modelLeaf, x_new };
  }

  async anchorBatch(leaves: MerkleLeaf[], meta: RoundMeta): Promise<AnchorResult> {
    const tree = new MerkleTree(leaves);
    const cid = await this.offchain.put(leaves);
    const header: AnchorHeader = {
      merkle_root: tree.root,
      cid,
      batch_id: `batch-${meta.session_id.slice(0, 8)}-r${meta.round_id}`,
      session_id: meta.session_id,
      round_id: meta.round_id,
      timestamp: meta.now(),
      submitter_id: this.aggregator.id,
      previous_tx_hash: await this.onchain.head(),
    };
    const tx_sig = this.aggregator.wallet.sign(sha256hex(canonicalize(header)));
    const tx_hash = Anchor.txHash(header, tx_sig);
    const anchor = new Anchor({ ...header, tx_sig, tx_hash });
    await this.onchain.append(anchor);
    for (const leaf of leaves) await this.logs.save(leaf);
    return { tree, cid, anchor, tx_sig };
  }
}

export interface DepositGradientInput {
  sender: string; // the trainer named in the x-party header
  wireLeaf: unknown; // the signed UPDATE_GRADIENT leaf (request body)
  session_id: string; // session named in the request (path param)
  round_id: number; // round named in the request (path param)
  registry: KeyRegistry;
}

export type ValidateResult =
  | { ok: true; leaf: MerkleLeaf }
  | { ok: false; reason: string };

// Stateless validation for POST /api/gradient/:session_id/:round_id. Confirms the
// sender is a known trainer, the signed leaf is well-formed and bound to the session/
// round named in the request, the leaf signer matches the x-party sender, and the
// signature verifies. No Redis / no instance state — the "round is open" guard stays
// in depositGradient (it needs the round repo), so this stays pure and unit-testable.
export function validateDepositGradient(input: DepositGradientInput): ValidateResult {
  const { sender, wireLeaf, session_id, round_id, registry } = input;

  const peer = trainerPeers().find((p) => p.name === sender);
  if (!peer) return { ok: false, reason: `unknown trainer '${sender}'` };

  let leaf: MerkleLeaf;
  try {
    leaf = MerkleLeaf.fromWire(wireLeaf as never);
  } catch {
    return { ok: false, reason: "malformed gradient leaf" };
  }

  if (leaf.fields.actor !== refOf(sender)) return { ok: false, reason: "x-party header does not match leaf signer" };
  if (leaf.fields.session_id !== session_id) return { ok: false, reason: "gradient session does not match request" };
  if (leaf.fields.round_id !== round_id) return { ok: false, reason: "gradient is for a different round" };

  const v = leaf.verify(registry, { session_id, round_id, type: "UPDATE_GRADIENT", actors: [refOf(sender)] });
  if (!v.ok) return { ok: false, reason: v.reason ?? "verification failed" };

  return { ok: true, leaf };
}
