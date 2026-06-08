import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { createScanner } from "./scanner.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const scanner = createScanner(config, database);

const app = Fastify({ logger: true });

await app.register(cookie);
await registerAuth(app, config);

if (config.isProduction) {
  await app.register(fastifyStatic, {
    root: path.resolve("dist/client"),
    prefix: "/",
    setHeaders(response, filePath) {
      if (path.basename(filePath) === "index.html") {
        response.setHeader("Cache-Control", "no-store, must-revalidate");
      } else {
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  });
}

await registerRoutes(app, { config, database, scanner });

await app.listen({ host: "0.0.0.0", port: config.port });
