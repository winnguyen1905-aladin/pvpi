import express from "express";
import type { Request, Response, Router } from "express";

// API surface of a trainer (B / C): receive A's broadcast model x for a given round,
// plus an identity endpoint for the presentation UI. Pure transport.
export interface TrainerHandlers {
  // POST /api/model/:session_id/:round_id — session/round come from the request.
  model(sender: string, session_id: string, round_id: number, body: any): Promise<unknown> | unknown;
  // GET /api/identity — this trainer's own keypair + secret (presentation only).
  identity(): Promise<unknown> | unknown;
  // GET /api/serverlog — this trainer's recent server-side log lines (presentation only).
  serverlog(): Promise<unknown> | unknown;
  // POST /api/serverlog/reset — clear this trainer's log buffer (on a new session).
  resetlog(): Promise<unknown> | unknown;
}

export function trainerRouter(h: TrainerHandlers): Router {
  const r = express.Router();

  // A broadcasts the SEND(x) here; the sender (A) comes from the x-party header. The
  // trainer verifies, computes its gradient, and pushes it back to A.
  r.post("/api/model/:session_id/:round_id", async (req: Request, res: Response) => {
    // a party name only ever needs [A-Za-z0-9._-]; strip anything else so a forged header can't
    // be echoed into logs/responses (the rejected line is surfaced in the server-log UI)
    const sender = (req.get("x-party") ?? "").replace(/[^\w.-]/g, "").slice(0, 32);
    const session_id = String(req.params.session_id);
    const round_id = Number(req.params.round_id);
    res.json(await h.model(sender, session_id, round_id, req.body));
  });

  r.get("/api/identity", async (_req: Request, res: Response) => {
    res.json(await h.identity());
  });

  r.get("/api/serverlog", async (_req: Request, res: Response) => {
    res.json(await h.serverlog());
  });

  r.post("/api/serverlog/reset", async (_req: Request, res: Response) => {
    res.json(await h.resetlog());
  });

  return r;
}