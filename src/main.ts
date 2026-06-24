// Single entry point. A and B/C are all HTTP servers (push-star topology).
//   node src/main.ts agg            -> aggregator A on :3001 (drives rounds)
//   node src/main.ts trainer B      -> trainer B on :3002  (trainer C -> :3003)
// On boot A creates one session (UUID) bound to this process; `round [x]` broadcasts
// SEND(x) to its trainers (POST /api/model/:session_id/:round_id); they verify, compute,
// and push their gradient back (POST A/api/gradient); A aggregates + anchors. Restart = a
// new session (no continuation).
import { CONFIG, REDIS_URL, peerUrl } from "./infra/config.ts";
import { aggregatorName, partyConfig, portOf } from "./infra/parties.ts";
import { createAggregatorNode, createTrainerNode } from "./app/factory.ts";
import { startRepl } from "./app/repl.ts";

async function runAggregator(name: string): Promise<void> {
  const cfg = partyConfig(name);
  if (cfg.role !== "aggregator") {
    console.error(`'${name}' is role '${cfg.role}', not the aggregator`);
    process.exit(1);
  }
  const port = portOf(name);
  const node = createAggregatorNode({ name });
  node.listen(port);
  console.log(`${name} (aggregator) on ${peerUrl(port)}  pubKeyRef=${node.pubKeyRef}`);
  console.log(`redis: ${REDIS_URL}`);

  // A session is bound to this process: create a fresh one (UUID) on boot with the
  // configured trainers and drive every round against it. Restarting starts a new
  // session; the previous one stays in Redis but is not reconnected (no recovery).
  const active = await node.svc.createSession(CONFIG.parties.trainers);
  console.log(`session ${active.session_id} (trainers: ${CONFIG.parties.trainers.join(",")})`);

  if (process.env.NO_REPL === "1") {
    console.log("  (headless — no REPL; drive rounds from the web UI / HTTP API)");
    return;
  }

  startRepl(`${name}> `, {
    round: {
      help: "run one round: round [x]  (x defaults to the session model). Broadcasts, aggregates, anchors.",
      run: async (a) => {
        const r = await node.svc.runRound(active.session_id, a[0] !== undefined ? Number(a[0]) : undefined);
        console.log(`  round ${r.round_id}: x_new=${r.x_new}  tx=${r.tx_hash.slice(0, 20)}…`);
      },
    },
    status: {
      help: "show this session's model x",
      run: async () => {
        console.log(`  model=${await node.svc.model(active.session_id)}`);
      },
    },
    sessions: {
      help: "list all sessions (id, trainers, model x, status)",
      run: async () => {
        for (const s of await node.svc.listSessions()) {
          const cur = s.session_id === active.session_id ? " (current)" : "";
          console.log(`  ${s.session_id}  trainers=${s.trainers.join(",")}  x=${s.model ?? "-"}  ${s.status}${cur}`);
        }
      },
    },
  });
}

async function runTrainer(name: string): Promise<void> {
  const cfg = partyConfig(name);
  if (cfg.role !== "trainer") {
    console.error(`'${name}' is role '${cfg.role}', not a trainer`);
    process.exit(1);
  }
  const port = portOf(name);
  const node = createTrainerNode({ name });
  node.listen(port);
  console.log(`${name} (trainer) on ${peerUrl(port)}  secret=${cfg.secret}  pubKeyRef=${node.pubKeyRef}`);
  console.log("  (auto-responds to A's broadcast on POST /api/model/:session_id/:round_id)");

  if (process.env.NO_REPL === "1") {
    console.log("  (headless — no REPL; serving)");
    return;
  }

  startRepl(`${name}> `, {
    secret: { help: "set local secret: secret <n>", run: (a) => node.svc.setSecret(Number(a[0])) },
    status: { help: "show role / secret / aggregator", run: () => node.svc.status() },
  });
}

const role = process.argv[2];
const name = process.argv[3];
if (role === "agg") {
  await runAggregator(name ?? aggregatorName());
} else if (role === "trainer") {
  if (!name) {
    console.error("usage: node src/main.ts trainer <name>   e.g. trainer B | trainer C");
    process.exit(1);
  }
  await runTrainer(name);
} else {
  console.error("usage: node src/main.ts <agg [name] | trainer <name>>   e.g. agg | trainer B | trainer C");
  process.exit(1);
}
