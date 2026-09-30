import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { createScanner } from "./scanner.js";
import { acquireDataLock } from "./data-lock.js";

const config = loadConfig();
const dataLock = acquireDataLock(config.dataDir);
let openedDatabase: DatabaseHandle | undefined;
process.once("exit", () => {
  try { if (openedDatabase?.db.open) openedDatabase.db.close(); }
  finally { dataLock.release(); }
});
fs.mkdirSync(config.artworkDir, { recursive: true });
fs.mkdirSync(config.metadataDir, { recursive: true });
const database = openedDatabase = openDatabase(config.databasePath);
database.recoverInterruptedScans();
const scanner = createScanner(config, database);

const app = Fastify({ logger: true });

await app.register(cookie);
await registerAuth(app, config, database);

if (config.isProduction) {
  await app.register(fastifyStatic, {
    root: path.resolve("dist/client"),
    prefix: "/",
    setHeaders(reply, filePath) {
      if (path.basename(filePath) === "index.html") {
        reply.header("Cache-Control", "no-store, must-revalidate");
      } else {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  });
}

await registerRoutes(app, { config, database, scanner });

await app.listen({ host: "0.0.0.0", port: config.port });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // A streaming connection must not indefinitely prevent an intentional shutdown.
  // An interrupted background scan is recovered on the next exclusive startup.
  const deadline = setTimeout(() => process.exit(0), 5_000);
  deadline.unref();
  void app.close().then(() => process.exit(0), () => process.exit(1));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
