// Static server for the presentation page (web/). Served over http://localhost so the
// browser treats it as a secure context (Web Crypto available) and the UI can fetch the
// A/B/C APIs cross-origin (CORS is enabled on each party).
//   npm run present     -> http://localhost:8080  (PRESENT_PORT to override)
import express from "express";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PRESENT_PORT ?? 8080);
const webDir = fileURLToPath(new URL("../web", import.meta.url));

const app = express();
app.use(express.static(webDir));
app.listen(PORT, () => {
  console.log(`presentation on http://localhost:${PORT}  (serving ${webDir})`);
});
