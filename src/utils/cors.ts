import type { Request, Response, NextFunction } from "express";

// Permissive dev CORS so the presentation page (served on another localhost port)
// can call each party's API. Localhost-only demo — not for production.
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-party");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
