import type { FastifyInstance } from "fastify";
import type { UserPreferences } from "../shared/accounts.js";
import { clearSession } from "./auth.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (maxLength: number, minLength = 0) => ({ type: "string", minLength, maxLength });
const identity = { displayName: string(96, 1), role: { type: "string", enum: ["admin", "member"] }, grantConfirmed: { type: "boolean" } };
export async function registerAccountRoutes(app: FastifyInstance) {
  const accounts = app.accounts!;
  app.patch<{ Body: { displayName: string; bio: string; color: string } }>("/api/account/profile", {
    schema: { body: object({ displayName: string(96, 1), bio: string(320), color: { type: "string", enum: ["rose", "sage", "blue"] } }, ["displayName", "bio", "color"]) }
  }, async (request) => accounts.profile(request.account!.id, request.body));
  app.patch<{ Body: Partial<UserPreferences> }>("/api/account/preferences", {
    schema: { body: object({
      dense: { type: "boolean" }, darkMode: { type: "boolean" }, volume: { type: "number", minimum: 0, maximum: 100 },
      shuffle: { type: "boolean" }, repeat: { type: "integer", enum: [0, 1, 2] },
      queue: { type: "array", maxItems: 10000, uniqueItems: true, items: string(128, 1) },
      currentId: string(128), position: { type: "number", minimum: 0, maximum: 86400 }
    }) }
  }, async (request) => accounts.savePreferences(request.account!.id, request.body));
  app.post<{ Body: { currentPassword: string; password: string } }>("/api/auth/password", {
    schema: { body: object({ currentPassword: string(1024, 1), password: string(256, 8) }, ["currentPassword", "password"]) }
  }, async (request, reply) => {
    const firstUse = request.account!.mustChangePassword;
    const user = await accounts.password(request.account!, request.body.currentPassword, request.body.password, firstUse ? request.sessionId : undefined);
    if (!firstUse) clearSession(reply);
    return { user, loggedOut: !firstUse };
  });
  app.get("/api/account/sessions", async (request) => accounts.sessions(request.account!.id, request.sessionId!));
  app.delete<{ Body: { ids: string[] } }>("/api/account/sessions", {
    schema: { body: object({ ids: { type: "array", maxItems: 500, items: string(128, 1), uniqueItems: true } }, ["ids"]) }
  }, async (request, reply) => {
    accounts.revoke(request.account!.id, request.body.ids);
    if (request.body.ids.includes(request.sessionId!)) clearSession(reply);
    return { ok: true };
  });
  app.get("/api/admin/users", async (request) => accounts.list(request.account!));
  app.post<{ Body: { username: string; displayName: string; role: string; grantConfirmed?: boolean } }>("/api/admin/users", {
    schema: { body: object({ username: string(24, 2), ...identity }, ["username", "displayName", "role"]) }
  }, async (request, reply) => {
    const result = await accounts.create(request.account!, request.body);
    return reply.status(201).send(result);
  });
  app.patch<{ Params: { id: string }; Body: { displayName?: string; role?: string; status?: string; grantConfirmed?: boolean } }>("/api/admin/users/:id", {
    schema: { body: object({ ...identity, status: { type: "string", enum: ["active", "disabled"] } }) }
  }, async (request) => accounts.update(request.account!, request.params.id, request.body));
  app.post<{ Params: { id: string }; Body: { password: string } }>("/api/admin/users/:id/password", {
    schema: { body: object({ password: string(256, 8) }, ["password"]) }
  }, async (request) => accounts.reset(request.account!, request.params.id, request.body.password));
}
