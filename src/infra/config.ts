import type { SimConfig } from "../types/sim.ts";

export interface PeerInfo {
  role: string;
  port: number;
  url: string;
}

export const HOST = "127.0.0.1";

export function peerUrl(port: number): string {
  return `http://${HOST}:${port}`;
}

// Ports overridable via env so the demo works when a default is taken:
//   AGG_PORT=3001 TRAINER_PORTS=3012,3013
function envPort(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

function envTrainerPorts(): number[] {
  const raw = process.env.TRAINER_PORTS;
  if (!raw) return [3002, 3003];
  const ports = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ports.length > 0 ? ports : [3002, 3003];
}

const AGG_PORT = envPort("AGG_PORT", 3001);
export const AGGREGATOR: PeerInfo = { role: "A", port: AGG_PORT, url: peerUrl(AGG_PORT) };

export const TRAINERS: PeerInfo[] = envTrainerPorts().map((port, i) => {
  const role = String.fromCharCode(66 + i); // B, C, D, …
  return { role, port, url: peerUrl(port) };
});

export const DEFAULT_SECRET: Record<string, number> = { B: 10, C: 5 };

export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const START_X = 100;

export const CONFIG: SimConfig = {
  input_type: "scalar",
  operation: "+",
  parties: { aggregator: "A", trainers: ["B", "C"] },
  rounds: 1,
  anchor_policy: "per-round",
  version: "v1",
  y_max: 1_000_000,
};
