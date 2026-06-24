import { Ed25519Key } from "../types/ed25519-key.ts";
import { KeyRegistry } from "../types/key-registry.ts";
import { AGGREGATOR, TRAINERS, peerUrl } from "./config.ts";

export interface Peer {
  name: string;
  url: string;
  ref: string; // pubKeyRef
}

// Pre-shared ed25519 identities for the parties (fixed PEMs => stable pubKeyRef
// across runs). Mock testnet keys — fine to commit. Ports live in config.ts.
//
// Isolation: `publicKeyPem` is the SHARED, public part — everyone uses it (registry
// + refs) to VERIFY each other. `privateKeyPem` is the node's own secret: it is read
// ONLY for the running node's own identity (loadKey below), never for another node.
// Same for the aggregator wallet. (Kept in this config file for simplicity rather
// than per-node env/secret files.)
export type PartyRole = "aggregator" | "trainer";

export interface PartyConfig {
  id: string; // stable user-id for the party (independent of name / pubKeyRef)
  name: string;
  role: PartyRole;
  publicKeyPem: string; // shared: used by everyone to verify this party
  privateKeyPem: string; // secret: loaded only by this party's own process
  secret?: number; // trainers only
  walletKeyPem?: string; // aggregator only (secret)
}

export const PARTIES: Record<string, PartyConfig> = {
  A: {
    id: "7bbcf776-47a5-48b9-b851-6df7195db0f4",
    name: "A",
    role: "aggregator",
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXuHwO3N7T1OJOoXfS5NcTYiLrY37fCpm4aJtA6EcKw4=
-----END PUBLIC KEY-----`,
    privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH1Wo22X0+FySW9UegUV7Wj7AOQqAQ4YLS0MBNmi5VX+
-----END PRIVATE KEY-----`,
    walletKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIC7VPzqN6pD2gnglNQynt4UFYt7kl4H2eooEVwcB0pu5
-----END PRIVATE KEY-----`,
  },
  B: {
    id: "31cda20f-abcd-415c-8050-0814c640b0e7",
    name: "B",
    role: "trainer",
    secret: 10,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPOnX19wc21NIAYYn/ddJ2o+B+hsf4n7yp28uwGdjJfM=
-----END PUBLIC KEY-----`,
    privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEILmgfNKvty3tAgJyTSNMjigCPFKktx9QYhzWkBnK1+dU
-----END PRIVATE KEY-----`,
  },
  C: {
    id: "3bd1c0d7-3d0c-4125-a304-ca9226748238",
    name: "C",
    role: "trainer",
    secret: 5,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOZHghDW6J7RWxOh9v+gNxTyGK2mp7M26wwO4WYTQ0mw=
-----END PUBLIC KEY-----`,
    privateKeyPem: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPEKV2rXkj+cOZIHCa9o8+YEeanVwQws6ILQp5kov6GO
-----END PRIVATE KEY-----`,
  },
};

export function partyConfig(name: string): PartyConfig {
  const p = PARTIES[name];
  if (!p) throw new Error(`unknown party '${name}' (config has: ${Object.keys(PARTIES).join(", ")})`);
  return p;
}

// The node's OWN full (signing) key. Loads a PRIVATE key, so only call this for the
// running node's own identity — never for another party (others are public-only).
export function loadKey(name: string): Ed25519Key {
  return Ed25519Key.fromPrivatePem(partyConfig(name).privateKeyPem);
}

// A registry seeded with every party's PUBLIC key (verify-only) — no handshake, and
// no private material: a node can verify the others without holding their secrets.
export function buildRegistry(): KeyRegistry {
  const reg = new KeyRegistry();
  for (const p of Object.values(PARTIES)) reg.register(Ed25519Key.fromPublicPem(p.publicKeyPem));
  return reg;
}

// Fixed port for a party by name (A from AGGREGATOR, trainers from TRAINERS):
// A=3001, B=3002, C=3003 by default (env-overridable).
export function portOf(name: string): number {
  if (partyConfig(name).role === "aggregator") return AGGREGATOR.port;
  const t = TRAINERS.find((p) => p.role === name);
  if (!t) throw new Error(`no port configured for trainer '${name}' (TRAINER_PORTS)`);
  return t.port;
}

// pubKeyRef for a party by name, derived from its PUBLIC key (no private load) —
// used to cross-check the x-party header against the leaf signer (leaf.fields.actor).
export function refOf(name: string): string {
  return Ed25519Key.fromPublicPem(partyConfig(name).publicKeyPem).pubKeyRef;
}

// Static peer (name + url + pubKeyRef) from config, since ports are fixed.
export function peerOf(name: string): Peer {
  return { name, url: peerUrl(portOf(name)), ref: refOf(name) };
}

// The aggregator's view of the trainers (B, C): where to call them + who to trust.
export function trainerPeers(): Peer[] {
  return Object.values(PARTIES)
    .filter((p) => p.role === "trainer")
    .map((p) => peerOf(p.name));
}

// Name of the single aggregator account (from config role), so neither the factory
// nor the trainers hardcode "A".
export function aggregatorName(): string {
  const a = Object.values(PARTIES).find((p) => p.role === "aggregator");
  if (!a) throw new Error("no aggregator configured");
  return a.name;
}

// A trainer's view of the aggregator (A): where to call (url) + who to trust (ref).
// Trainers are pure clients now — they pull/submit to A at this address.
export function aggregatorPeer(): Peer {
  return peerOf(aggregatorName());
}
