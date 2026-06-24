import { postJson, short } from "../utils/http-client.ts";
import { logLine } from "../utils/log.ts";
import { CONFIG } from "../infra/config.ts";
import type { Peer } from "../infra/parties.ts";
import { Trainer } from "../model/trainer.model.ts";
import { MerkleLeaf } from "../model/merkle-leaf.model.ts";
import { KeyRegistry } from "../types/key-registry.ts";
import type { Operation, RoundMeta } from "../types/sim.ts";

type Logger = (m: string) => void;

export interface TrainerOpts {
  aggregator?: Peer; // A: url + pubKeyRef (fixed from config)
  log?: Logger;
}

// Trainer B / C — a server for POST /api/model/:session_id/:round_id (receives A's broadcast) AND an
// outbound client (pushes its gradient to A's POST /api/gradient). `onBroadcast`
// verifies A's SEND, computes the UPDATE_GRADIENT, and pushes it back to A.
export class TrainerService {
  private trainer: Trainer;
  private registry: KeyRegistry;
  private aggregator?: Peer;
  private log: Logger;

  constructor(trainer: Trainer, registry: KeyRegistry, opts: TrainerOpts = {}) {
    this.trainer = trainer;
    this.registry = registry;
    this.aggregator = opts.aggregator;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  // Handle A's broadcast (POST /api/model/:session_id/:round_id). `sender` is the x-party header (must be
  // A). Verify A's SEND, compute this trainer's gradient, and push it to A.
  async onBroadcast(
    sender: string,
    session_id: string,
    round_id: number,
    wireSend: unknown,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.aggregator) throw new Error("TrainerService: aggregator peer required");
    const me = this.trainer.name;
    const v = validateBroadcast({ sender, wireSend, session_id, round_id, aggregator: this.aggregator, registry: this.registry });
    if (!v.ok) {
      this.log(logLine(sender, me, `rejected: ${v.reason}`));
      return { ok: false, reason: v.reason };
    }
    
    const sendLeaf = v.leaf;
    const meta: RoundMeta = { config: CONFIG, session_id, round_id, now: Date.now };
    const gradient: MerkleLeaf = this.handleSend(sendLeaf, meta);
    this.log(logLine(sender, me, `SEND x=${sendLeaf.fields.payload} (round ${round_id})`));
    const url = `${this.aggregator.url}/api/gradient/${encodeURIComponent(meta.session_id)}/${meta.round_id}`;
    await postJson(url, { leaf: gradient.toWire() }, { "x-party": me });
    this.log(logLine(me, this.aggregator.name, `UPDATE_GRADIENT x'=${gradient.fields.payload} ${short(gradient.leaf_hash)}`));
    return { ok: true };
  }

  setSecret(n: number): void {
    this.trainer.secret = n;
    this.log(logLine(this.trainer.name, this.trainer.name, `secret=${n}`));
  }

  status(): void {
    const agg = this.aggregator ? `${this.aggregator.name}@${this.aggregator.url}` : "(none)";
    this.log(`  role=${this.trainer.name} secret=${this.trainer.secret} aggregator=${agg}`);
  }

  // B3: range-check the secret, compute x' = x OP secret, sign. (A's SEND is verified up
  // front by validateBroadcast before this runs.)
  handleSend(sendLeaf: MerkleLeaf, meta: RoundMeta): MerkleLeaf {
    if (this.trainer.secret < 0 || this.trainer.secret > meta.config.y_max) {
      throw new Error(
        `range-check failed for ${this.trainer.name}: secret ${this.trainer.secret} not in [0, ${meta.config.y_max}]`,
      );
    }
    const x = sendLeaf.fields.payload as number;
    const update = TrainerService.applyOp(meta.config.operation, x, this.trainer.secret);
    return this.trainer.createLeaf({
      type: "UPDATE_GRADIENT",
      session_id: meta.session_id,
      round_id: meta.round_id,
      payload: update,
      version: meta.config.version,
      timestamp: meta.now(),
    });
  }

  // Per-trainer local update (the configurable arithmetic of §3.1.2).
  static applyOp(op: Operation, a: number, b: number): number {
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        if (b === 0) throw new Error("division by zero is forbidden (D2 §3.1.5)");
        return a / b;
    }
  }
}

export interface ValidateBroadcastInput {
  sender: string; // the x-party header (must be the aggregator)
  wireSend: unknown; // the signed SEND leaf (request body)
  session_id: string; // session named in the request (path param)
  round_id: number; // round named in the request (path param)
  aggregator: Peer; // expected aggregator: name + pubKeyRef
  registry: KeyRegistry;
}

export type ValidateBroadcastResult =
  | { ok: true; leaf: MerkleLeaf }
  | { ok: false; reason: string };

// Stateless validation of A's broadcast (POST /api/model/:session_id/:round_id). Confirms the sender is the
// aggregator, the SEND leaf is well-formed and signed by the aggregator, and the
// signature verifies. The mirror of validateDepositGradient on the trainer side; the
// secret range-check stays in handleSend (it is a local precondition, not the message).
export function validateBroadcast(input: ValidateBroadcastInput): ValidateBroadcastResult {
  const { sender, wireSend, session_id, round_id, aggregator, registry } = input;

  if (sender !== aggregator.name) return { ok: false, reason: `sender '${sender}' is not the aggregator` };

  let leaf: MerkleLeaf;
  try {
    leaf = MerkleLeaf.fromWire(wireSend as never);
  } catch {
    return { ok: false, reason: "malformed SEND leaf" };
  }

  if (leaf.fields.actor !== aggregator.ref) return { ok: false, reason: "x-party header does not match SEND signer" };
  if (leaf.fields.session_id !== session_id) return { ok: false, reason: "SEND session does not match request" };
  if (leaf.fields.round_id !== round_id) return { ok: false, reason: "SEND is for a different round" };

  const v = leaf.verify(registry, { session_id, round_id, type: "SEND", actors: [aggregator.ref] });
  if (!v.ok) return { ok: false, reason: v.reason ?? "SEND verification failed" };

  return { ok: true, leaf };
}
