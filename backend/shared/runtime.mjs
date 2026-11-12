import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
export const names = [
  "auth",
  "catalog",
  "inventory",
  "orders",
  "payments",
  "shipping",
];
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
export function assert(v, msg = "Invalid request", status = 400) {
  if (!v) fail(status, msg);
}
export function database(name) {
  const dir = resolve(process.env.DATA_DIR || "backend/data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(resolve(dir, name + ".sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
  return db;
}
export const get = (db, key) => {
  let r = db.prepare("SELECT body FROM documents WHERE id=?").get(String(key));
  return r ? JSON.parse(r.body) : null;
};
export const all = (db) =>
  db
    .prepare("SELECT body FROM documents")
    .all()
    .map((x) => JSON.parse(x.body));
export const put = (db, v) => {
  db.prepare(
    "INSERT INTO documents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
  ).run(String(v.id), JSON.stringify(v));
  return v;
};
export function txn(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export const secret = () => {
  assert(
    process.env.INTERNAL_KEY?.length >= 32,
    "Set INTERNAL_KEY (at least 32 characters)",
    500,
  );
  return process.env.INTERNAL_KEY;
};
export function internal(req) {
  return req.headers["x-internal-key"] === secret();
}
export const requireInternal = (req) =>
  assert(internal(req), "Internal service credentials required", 403);
export async function call(service, path, method = "GET", body) {
  let res;
  try {
    res = await fetch(
      (process.env[service.toUpperCase() + "_URL"] ||
        `http://127.0.0.1:${8081 + names.indexOf(service)}`) + path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": secret(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(2500),
      },
    );
  } catch {
    fail(503, `${service} temporarily unavailable`);
  }
  const data = await res.json();
  if (!res.ok) fail(res.status, data.message || "Upstream service error");
  return data;
}
export async function actor(req) {
  if (internal(req)) return { id: "system", role: "SYSTEM" };
  const token = req.headers.authorization;
  assert(token?.startsWith("Bearer "), "Authentication required", 401);
  let res;
  try {
    res = await fetch(
      (process.env.AUTH_URL || "http://127.0.0.1:8081") + "/api/auth/me",
      { headers: { Authorization: token }, signal: AbortSignal.timeout(2500) },
    );
  } catch {
    fail(503, "Auth temporarily unavailable");
  }
  if (!res.ok) fail(401, "Session expired or invalid");
  return res.json();
}
export function own(user, doc) {
  assert(doc, "Not found", 404);
  assert(
    user.role === "SYSTEM" || doc.userId === user.id,
    "Access denied",
    403,
  );
  return doc;
}
export function items(value) {
  assert(
    Array.isArray(value) && value.length > 0 && value.length <= 100,
    "A non-empty items array is required",
  );
  const m = new Map();
  for (const x of value) {
    assert(
      Number.isSafeInteger(x.productId) &&
        x.productId > 0 &&
        Number.isSafeInteger(x.quantity) &&
        x.quantity > 0 &&
        x.quantity <= 10000,
      "Invalid product or quantity",
    );
    m.set(x.productId, (m.get(x.productId) || 0) + x.quantity);
  }
  return [...m].map(([productId, quantity]) => ({ productId, quantity }));
}
const locks = new Map();
export async function locked(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((r) => (release = r));
  locks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}
export function serve(name, handler) {
  secret();
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const origins = (
      process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",");
    if (origins.includes(origin))
      res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,Idempotency-Key",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const requestId = id();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Content-Type", "application/json");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health")
        return res.end(JSON.stringify({ service: name, status: "UP" }));
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        assert(raw.length < 131072, "Payload too large", 413);
      }
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          fail(400, "Invalid JSON");
        }
      }
      const data = await handler(req, url, body);
      res.end(JSON.stringify(data ?? { success: true }));
      console.log(
        JSON.stringify({
          at: now(),
          service: name,
          method: req.method,
          path: url.pathname,
          status: 200,
          requestId,
        }),
      );
    } catch (e) {
      res.statusCode = e.status || 500;
      res.end(
        JSON.stringify({
          message: e.status ? e.message : "Internal server error",
          requestId,
        }),
      );
      console.log(
        JSON.stringify({
          at: now(),
          service: name,
          method: req.method,
          path: req.url,
          status: res.statusCode,
          requestId,
        }),
      );
      if (!e.status) console.error(e);
    }
  });
  server.listen(
    Number(process.env.PORT) || 8081 + names.indexOf(name),
    process.env.HOST || "127.0.0.1",
    () => console.log(name + " ready"),
  );
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  return server;
}
