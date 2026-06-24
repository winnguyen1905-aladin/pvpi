import express from "express";
import type { Request, Response, Router } from "express";

export interface AggregatorHandlers {
  // POST /api/gradient/:session_id/:round_id — session/round come from the request.
  gradient(sender: string, session_id: string, round_id: number, body: any): Promise<unknown> | unknown;
}

export function aggregatorRouter(h: AggregatorHandlers): Router {
  const r = express.Router();

  r.post("/api/gradient/:session_id/:round_id", async (req: Request, res: Response) => {
    const sender = req.get("x-party") ?? "";
    const session_id = String(req.params.session_id);
    const round_id = Number(req.params.round_id);
    res.json(await h.gradient(sender, session_id, round_id, req.body));
  });

  return r;
}
