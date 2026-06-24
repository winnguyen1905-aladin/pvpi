import express from "express";
import type { Express } from "express";
import type { Server } from "node:http";
import { aggregatorName, aggregatorPeer, buildRegistry, loadKey, partyConfig } from "../infra/parties.ts";
import { Ed25519Key } from "../types/ed25519-key.ts";
import { Aggregator } from "../model/aggregator.model.ts";
import { Trainer } from "../model/trainer.model.ts";
import { logRepo } from "../repo/log-repo.ts";
import { offchainRepo } from "../repo/offchain-repo.ts";
import { onchainRepo } from "../repo/onchain-repo.ts";
import { roundRepo } from "../repo/round-repo.ts";
import { sessionRepo } from "../repo/session-repo.ts";
import { sessionMemberRepo } from "../repo/session-member-repo.ts";
import { AggregatorService } from "../service/aggregator-service.ts";
import { TrainerService } from "../service/trainer-service.ts";
import { aggregatorRouter } from "../router/agg-router.ts";
import type { AggregatorHandlers } from "../router/agg-router.ts";
import { trainerRouter } from "../router/trainer-router.ts";
import type { TrainerHandlers } from "../router/trainer-router.ts";
import { uiRouter } from "../router/ui-router.ts";
import type { UiHandlers } from "../router/ui-router.ts";
import { cors } from "../utils/cors.ts";

export interface AggregatorNodeOpts {
  name?: string; // aggregator account (defaults to the config aggregator)
  log?: (m: string) => void;
}

export interface AggregatorNode {
  svc: AggregatorService;
  app: Express;
  pubKeyRef: string;
  publicKeyPem: string;
  listen(port: number): Server;
}

export function createAggregatorNode(opts: AggregatorNodeOpts = {}): AggregatorNode {
  const name = opts.name ?? aggregatorName();
  const cfg = partyConfig(name);
  if (cfg.role !== "aggregator") throw new Error(`'${name}' is role '${cfg.role}', not the aggregator`);
  const registry = buildRegistry();
  const walletKey = cfg.walletKeyPem ? Ed25519Key.fromPrivatePem(cfg.walletKeyPem) : Ed25519Key.generate();
  const aggregator = new Aggregator(name, loadKey(name), walletKey, cfg.id);

  // Capture A's activity-log lines (in addition to the normal sink) so the UI can show
  // the real round narrative in the round response.
  const activity: string[] = [];
  const log = (m: string): void => {
    activity.push(m);
    if (activity.length > 1000) activity.shift();
    (opts.log ?? ((s: string) => console.log(s)))(m);
  };

  const svc = new AggregatorService({
    aggregator,
    registry,
    offchain: offchainRepo,
    onchain: onchainRepo,
    logs: logRepo,
    round: roundRepo,
    sessions: sessionRepo,
    members: sessionMemberRepo,
    log,
  });

  const handlers: AggregatorHandlers = {
    gradient: (sender, session_id, round_id, body) => svc.depositGradient(sender, session_id, round_id, body.leaf),
  };

  const uiHandlers: UiHandlers = {
    identity: () => ({
      name: aggregator.name,
      role: "aggregator",
      id: aggregator.id,
      pubKeyRef: aggregator.pubKeyRef,
      publicKeyPem: aggregator.key.exportPublic(),
      privateKeyPem: cfg.privateKeyPem,
      walletAddress: aggregator.wallet.address,
    }),
    createSession: (trainers) => svc.createSession(trainers),
    runRound: async (session_id, x) => {
      const from = activity.length;
      const result = await svc.runRound(session_id, x);
      const leaves = (await logRepo.byRound(session_id, result.round_id)).map((l) => l.toWire());
      const chain = await onchainRepo.all();
      const anchor = chain.find((a) => a.tx_hash === result.tx_hash) ?? chain[chain.length - 1] ?? null;
      return { result, leaves, anchor, activity: activity.slice(from) };
    },
    sessions: () => svc.listSessions(),
    logs: async (s, rnd) => (await logRepo.byRound(s, rnd)).map((l) => l.toWire()),
    onchain: () => onchainRepo.all(),
    offchain: async (cid) => {
      const ls = await offchainRepo.get(cid);
      return { leaves: ls ? ls.map((l) => l.toWire()) : null };
    },
  };

  const app = express();
  app.use(cors);
  app.use(express.json());
  app.use(aggregatorRouter(handlers));
  app.use(uiRouter(uiHandlers));

  return {
    svc,
    app,
    pubKeyRef: aggregator.pubKeyRef,
    publicKeyPem: aggregator.key.exportPublic(),
    listen: (port) => app.listen(port, "127.0.0.1"),
  };
}

export interface TrainerNodeOpts {
  name: string; // config trainer name (B / C)
  log?: (m: string) => void;
}

export interface TrainerNode {
  svc: TrainerService;
  app: Express;
  pubKeyRef: string;
  publicKeyPem: string;
  listen(port: number): Server;
}

// Composition root for a trainer: a server for POST /api/model/:session_id/:round_id (A's broadcast) that
// computes its gradient and pushes it back to A. Keys + A's address come from config.
export function createTrainerNode(opts: TrainerNodeOpts): TrainerNode {
  const registry = buildRegistry();
  const cfg = partyConfig(opts.name);
  const trainer = new Trainer(opts.name, cfg.secret ?? 0, loadKey(opts.name), cfg.id);
  const svc = new TrainerService(trainer, registry, { aggregator: aggregatorPeer(), log: opts.log });

  const handlers: TrainerHandlers = {
    model: (sender, session_id, round_id, body) => svc.onBroadcast(sender, session_id, round_id, body.leaf),
    identity: () => ({
      name: trainer.name,
      role: "trainer",
      id: trainer.id,
      pubKeyRef: trainer.pubKeyRef,
      publicKeyPem: trainer.key.exportPublic(),
      privateKeyPem: cfg.privateKeyPem,
      secret: trainer.secret,
    }),
  };

  const app = express();
  app.use(cors);
  app.use(express.json());
  app.use(trainerRouter(handlers));

  return {
    svc,
    app,
    pubKeyRef: trainer.pubKeyRef,
    publicKeyPem: trainer.key.exportPublic(),
    listen: (port) => app.listen(port, "127.0.0.1"),
  };
}
