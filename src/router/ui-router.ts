import express from "express";
import type { Request, Response, Router } from "express";

// Presentation/inspection API mounted on the aggregator A (alongside the protocol
// agg-router). Lets the web UI show A's identity, trigger a session/round against the
// real backend, and read the resulting leaves + on/off-chain records.
export interface UiHandlers {
  identity(): Promise<unknown> | unknown;
  createSession(trainers: string[]): Promise<unknown>;
  runRound(session_id: string, x?: number): Promise<unknown>;
  sessions(): Promise<unknown>;
  logs(session_id: string, round_id: number): Promise<unknown>;
  onchain(): Promise<unknown>;
  offchain(cid: string): Promise<unknown>;
}

export function uiRouter(h: UiHandlers): Router {
  const r = express.Router();

  r.get("/api/identity", async (_req: Request, res: Response) => {
    res.json(await h.identity());
  });

  r.post("/api/session", async (req: Request, res: Response) => {
    const trainers: string[] = Array.isArray(req.body?.trainers) ? req.body.trainers : [];
    try {
      res.json(await h.createSession(trainers));
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? String(e) });
    }
  });

  r.post("/api/session/:session_id/round", async (req: Request, res: Response) => {
    const session_id = String(req.params.session_id);
    const x = req.body?.x !== undefined ? Number(req.body.x) : undefined;
    try {
      res.json(await h.runRound(session_id, x));
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? String(e) });
    }
  });

  r.get("/api/sessions", async (_req: Request, res: Response) => {
    res.json(await h.sessions());
  });

  r.get("/api/logs/:session_id/:round_id", async (req: Request, res: Response) => {
    res.json(await h.logs(String(req.params.session_id), Number(req.params.round_id)));
  });

  r.get("/api/onchain", async (_req: Request, res: Response) => {
    res.json(await h.onchain());
  });

  r.get("/api/offchain/:cid", async (req: Request, res: Response) => {
    res.json(await h.offchain(String(req.params.cid)));
  });

  return r;
}
