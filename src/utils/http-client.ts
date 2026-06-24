import type { Server } from "node:http";

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function short(h: string, n = 12): string {
  return h.length > n ? h.slice(0, n) + "…" : h;
}
