import http from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type {
  DeviceId,
  PairCode,
  WsClientHello,
  WsClientMessage,
  WsServerMessage,
  WsServerWelcome
} from "@sendpipe/shared";

type User = { sub: string; email?: string; name?: string; picture?: string };
type LocalUser = { id: string; email: string; passwordHash: string; createdAtMs: number };

type Session = {
  token: string;
  user: User;
  expiresAtMs: number;
};

type DeviceRecord = {
  deviceId: DeviceId;
  name: string;
  publicKeyJwk: JsonWebKey;
  ws: WebSocket;
  lastSeenMs: number;
  userSub: string | null;
};

type PairSession = {
  code: PairCode;
  createdAtMs: number;
  expiresAtMs: number;
  initiator: DeviceId;
  joiner?: DeviceId;
  sessionId: string;
  userSub: string | null;
};

const PORT = Number(process.env.PORT ?? "8787");
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT ?? "8788");
const LAN_DISCOVERY = process.env.LAN_DISCOVERY !== "0";
const PAIR_TTL_MS = 5 * 60 * 1000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "1";
const GOOGLE_AUTH_ENABLED = GOOGLE_CLIENT_ID.trim().length > 0;
const LOCAL_AUTH_ENABLED = process.env.LOCAL_AUTH === "1" || process.env.LOCAL_AUTH === "true";
const LOCAL_AUTH_PORTABLE = process.env.LOCAL_AUTH_PORTABLE !== "0";
const AUTH_ENABLED = AUTH_REQUIRED && (GOOGLE_AUTH_ENABLED || LOCAL_AUTH_ENABLED);

const sessions = new Map<string, Session>();
const localUsers = new Map<string, LocalUser>(); // email -> user
const devices = new Map<DeviceId, DeviceRecord>();
const pairSessions = new Map<PairCode, PairSession>();

function nowMs(): number {
  return Date.now();
}

function json(res: http.ServerResponse, code: number, value: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const body = Buffer.concat(chunks).toString("utf-8");
  if (!body.trim()) return null;
  return JSON.parse(body);
}

function cleanupExpiredSessions(): void {
  const t = nowMs();
  for (const [token, s] of sessions) {
    if (s.expiresAtMs <= t) sessions.delete(token);
  }
}

function randomDigits(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

function makePairCode(): PairCode {
  for (let i = 0; i < 20; i++) {
    const code = randomDigits(6);
    if (!pairSessions.has(code)) return code;
  }
  return String(nowMs()).slice(-6);
}

function safeSend(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function getUserSubForDevice(deviceId: DeviceId): string | null {
  return devices.get(deviceId)?.userSub ?? null;
}

function broadcastPresence(userSub: string | null): void {
  const snapshot = Array.from(devices.values())
    .filter((d) => d.userSub === userSub)
    .map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      online: d.ws.readyState === WebSocket.OPEN,
      lastSeenMs: d.lastSeenMs,
      publicKeyJwk: d.publicKeyJwk
    }));

  const msg: WsServerMessage = { type: "presence", devices: snapshot };
  for (const d of devices.values()) {
    if (d.userSub === userSub) safeSend(d.ws, msg);
  }
}

function cleanupExpiredPairs(): void {
  const t = nowMs();
  for (const [code, session] of pairSessions) {
    if (session.expiresAtMs <= t) pairSessions.delete(code);
  }
}

function issueSession(user: User): Session {
  const token = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs() + 7 * 24 * 60 * 60 * 1000;
  const s: Session = { token, user, expiresAtMs };
  sessions.set(token, s);
  return s;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashPassword(password: string, salt: string): string {
  const derived = scryptSync(password, salt, 32);
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const salt = parts[2];
  const expected = Buffer.from(parts[3], "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text}`.trim());
  }
  return await res.json();
}

async function googleDeviceStart(): Promise<{
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval?: number;
}> {
  const params = new URLSearchParams();
  params.set("client_id", GOOGLE_CLIENT_ID);
  params.set("scope", "openid email profile");
  return await fetchJson("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
}

async function googleDevicePoll(deviceCode: string): Promise<any> {
  const params = new URLSearchParams();
  params.set("client_id", GOOGLE_CLIENT_ID);
  params.set("device_code", deviceCode);
  params.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, data };
  return { ok: true, data };
}

async function googleTokenInfo(idToken: string): Promise<User> {
  const info = await fetchJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const sub = String(info.sub ?? "");
  if (!sub) throw new Error("tokeninfo missing sub");
  return {
    sub,
    email: info.email ? String(info.email) : undefined,
    name: info.name ? String(info.name) : undefined,
    picture: info.picture ? String(info.picture) : undefined
  };
}

function parseWsUrl(req: http.IncomingMessage): URL {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const urlStr = `${proto}://${host}${req.url ?? "/"}`;
  return new URL(urlStr);
}

const server = http.createServer(async (req, res) => {
  const url = parseWsUrl(req);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, { ok: true, authRequired: AUTH_ENABLED });
    return;
  }

  if (url.pathname === "/auth/google/device/start" && req.method === "POST") {
    if (!AUTH_REQUIRED || !GOOGLE_AUTH_ENABLED) {
      json(res, 400, { ok: false, error: "Google auth not enabled (set GOOGLE_CLIENT_ID)" });
      return;
    }
    try {
      const start = await googleDeviceStart();
      json(res, 200, { ok: true, ...start });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === "/auth/google/device/poll" && req.method === "POST") {
    if (!AUTH_REQUIRED || !GOOGLE_AUTH_ENABLED) {
      json(res, 400, { ok: false, error: "Google auth not enabled (set GOOGLE_CLIENT_ID)" });
      return;
    }
    cleanupExpiredSessions();
    try {
      const body = await readJson(req);
      const device_code = body?.device_code ? String(body.device_code) : "";
      if (!device_code) {
        json(res, 400, { ok: false, error: "Missing device_code" });
        return;
      }

      const polled = await googleDevicePoll(device_code);
      if (!polled.ok) {
        const err = String(polled.data?.error ?? "unknown_error");
        json(res, 200, { ok: false, pending: err === "authorization_pending", error: err });
        return;
      }

      const idToken = String(polled.data.id_token ?? "");
      if (!idToken) {
        json(res, 500, { ok: false, error: "No id_token received" });
        return;
      }
      const user = await googleTokenInfo(idToken);
      const session = issueSession(user);
      json(res, 200, { ok: true, sessionToken: session.token, user: session.user, expiresAtMs: session.expiresAtMs });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === "/auth/local/signup" && req.method === "POST") {
    if (!LOCAL_AUTH_ENABLED) {
      json(res, 400, { ok: false, error: "Local auth not enabled (set LOCAL_AUTH=1)" });
      return;
    }
    if (LOCAL_AUTH_PORTABLE) {
      json(res, 400, { ok: false, error: "Local auth is in portable-token mode; signup not required" });
      return;
    }
    cleanupExpiredSessions();
    try {
      const body = await readJson(req);
      const email = normalizeEmail(String(body?.email ?? ""));
      const password = String(body?.password ?? "");
      if (!email.includes("@") || email.length > 200) {
        json(res, 400, { ok: false, error: "Invalid email" });
        return;
      }
      if (password.length < 8 || password.length > 2000) {
        json(res, 400, { ok: false, error: "Password must be at least 8 characters" });
        return;
      }
      if (localUsers.has(email)) {
        json(res, 400, { ok: false, error: "Email already exists" });
        return;
      }

      const id = randomUUID();
      const salt = randomBytes(16).toString("base64url");
      const passwordHash = hashPassword(password, salt);
      localUsers.set(email, { id, email, passwordHash, createdAtMs: nowMs() });
      const user: User = { sub: `local:${id}`, email };
      const session = issueSession(user);
      json(res, 200, { ok: true, sessionToken: session.token, user: session.user, expiresAtMs: session.expiresAtMs });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e) });
    }
    return;
  }

  if (url.pathname === "/auth/local/login" && req.method === "POST") {
    if (!LOCAL_AUTH_ENABLED) {
      json(res, 400, { ok: false, error: "Local auth not enabled (set LOCAL_AUTH=1)" });
      return;
    }
    if (LOCAL_AUTH_PORTABLE) {
      json(res, 400, { ok: false, error: "Local auth is in portable-token mode; login not required" });
      return;
    }
    cleanupExpiredSessions();
    try {
      const body = await readJson(req);
      const email = normalizeEmail(String(body?.email ?? ""));
      const password = String(body?.password ?? "");
      const user = localUsers.get(email);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        json(res, 401, { ok: false, error: "Invalid email or password" });
        return;
      }
      const session = issueSession({ sub: `local:${user.id}`, email: user.email, name: user.email });
      json(res, 200, { ok: true, sessionToken: session.token, user: session.user, expiresAtMs: session.expiresAtMs });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e) });
    }
    return;
  }

  json(res, 404, { ok: false, error: "Not found" });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = parseWsUrl(req);
  if (url.pathname !== "/") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  let deviceId: DeviceId | null = null;
  let userSub: string | null = null;

  ws.on("message", (data) => {
    cleanupExpiredPairs();
    cleanupExpiredSessions();

    let msg: WsClientMessage;
    try {
      msg = JSON.parse(String(data)) as WsClientMessage;
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (msg.type === "hello") {
      const hello = msg as WsClientHello;

      if (AUTH_REQUIRED) {
        const token = hello.authToken ? String(hello.authToken) : "";
        if (LOCAL_AUTH_ENABLED && LOCAL_AUTH_PORTABLE && token.startsWith("local:") && token.length > "local:".length) {
          // Portable LAN auth: token itself defines the account scope (shared secret).
          userSub = token;
        } else {
          const session = token ? sessions.get(token) : undefined;
          if (!session || session.expiresAtMs <= nowMs()) {
            safeSend(ws, { type: "error", message: "Auth required (invalid session)" });
            ws.close();
            return;
          }
          userSub = session.user.sub;
        }
      } else {
        userSub = null;
      }

      deviceId = hello.deviceId;
      devices.set(hello.deviceId, {
        deviceId: hello.deviceId,
        name: hello.name,
        publicKeyJwk: hello.publicKeyJwk,
        ws,
        lastSeenMs: nowMs(),
        userSub
      });

      const welcome: WsServerWelcome = {
        type: "welcome",
        serverTimeMs: nowMs(),
        authRequired: AUTH_REQUIRED,
        user: userSub ? sessions.get(hello.authToken ?? "")?.user : undefined
      };
      safeSend(ws, welcome);

      console.log(
        `[signaling] hello ${hello.deviceId.slice(0, 8)} user=${userSub ? userSub.slice(0, 8) : "none"} name="${hello.name}"`
      );
      broadcastPresence(userSub);
      return;
    }

    if (!deviceId) {
      safeSend(ws, { type: "error", message: "Send hello first" });
      return;
    }

    const device = devices.get(deviceId);
    if (device) device.lastSeenMs = nowMs();

    switch (msg.type) {
      case "pair.create": {
        const code = makePairCode();
        const sessionId = randomUUID();
        const createdAtMs = nowMs();
        const expiresAtMs = createdAtMs + PAIR_TTL_MS;
        pairSessions.set(code, {
          code,
          createdAtMs,
          expiresAtMs,
          initiator: deviceId,
          sessionId,
          userSub
        });
        console.log(`[signaling] pair.create ${deviceId.slice(0, 8)} code=${code} user=${userSub ? userSub.slice(0, 8) : "none"}`);
        safeSend(ws, { type: "pair.created", code, expiresAtMs });
        return;
      }
      case "pair.join": {
        const session = pairSessions.get(msg.code);
        if (!session) {
          console.log(`[signaling] pair.join miss ${deviceId.slice(0, 8)} code=${msg.code}`);
          safeSend(ws, { type: "error", message: "Invalid or expired code" });
          return;
        }
        if (session.expiresAtMs <= nowMs()) {
          pairSessions.delete(msg.code);
          console.log(`[signaling] pair.join expired ${deviceId.slice(0, 8)} code=${msg.code}`);
          safeSend(ws, { type: "error", message: "Invalid or expired code" });
          return;
        }
        if (session.joiner) {
          console.log(`[signaling] pair.join used ${deviceId.slice(0, 8)} code=${msg.code}`);
          safeSend(ws, { type: "error", message: "Code already used" });
          return;
        }
        if (AUTH_REQUIRED && session.userSub !== userSub) {
          safeSend(ws, { type: "error", message: "Pair code belongs to a different account" });
          return;
        }

        session.joiner = deviceId;
        pairSessions.set(session.code, session);
        console.log(
          `[signaling] pair.matched code=${session.code} a=${session.initiator.slice(0, 8)} b=${deviceId.slice(0, 8)}`
        );

        const initiator = devices.get(session.initiator);
        const joiner = devices.get(deviceId);
        if (!initiator || !joiner) {
          safeSend(ws, { type: "error", message: "Peer not online" });
          return;
        }

        safeSend(initiator.ws, {
          type: "pair.matched",
          sessionId: session.sessionId,
          peer: { deviceId: joiner.deviceId, name: joiner.name, publicKeyJwk: joiner.publicKeyJwk }
        });
        safeSend(joiner.ws, {
          type: "pair.matched",
          sessionId: session.sessionId,
          peer: {
            deviceId: initiator.deviceId,
            name: initiator.name,
            publicKeyJwk: initiator.publicKeyJwk
          }
        });

        pairSessions.delete(session.code);
        return;
      }
      case "webrtc.offer":
      case "webrtc.answer":
      case "webrtc.ice": {
        const to = "to" in msg ? msg.to : null;
        if (!to) {
          safeSend(ws, { type: "error", message: "Missing 'to'" });
          return;
        }
        const target = devices.get(to);
        if (!target) {
          safeSend(ws, { type: "error", message: "Target offline" });
          return;
        }
        if (AUTH_REQUIRED) {
          const fromUser = getUserSubForDevice(deviceId);
          if (!fromUser || target.userSub !== fromUser) {
            safeSend(ws, { type: "error", message: "Not allowed" });
            return;
          }
        }
        safeSend(target.ws, { ...(msg as any), from: deviceId } satisfies WsServerMessage);
        return;
      }
      default: {
        safeSend(ws, { type: "error", message: "Unknown message type" });
      }
    }
  });

  ws.on("close", () => {
    if (deviceId) {
      const record = devices.get(deviceId);
      devices.delete(deviceId);
      if (record) broadcastPresence(record.userSub);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[signaling] http://localhost:${PORT} (ws at /)`);
  if (AUTH_REQUIRED && !AUTH_ENABLED && !LOCAL_AUTH_ENABLED) {
    console.log("[signaling] AUTH_REQUIRED=1 but no auth provider configured (GOOGLE_CLIENT_ID or LOCAL_AUTH=1)");
  }

  if (LAN_DISCOVERY) {
    const discoveryInstanceId = randomUUID();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (err) => console.log("[discovery] error", String(err)));
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString("utf-8").trim();
      if (text !== "SENDPIPE_DISCOVER_V1") return;
      const payload = JSON.stringify({
        type: "SENDPIPE_DISCOVERY_V1",
        instanceId: discoveryInstanceId,
        wsPort: PORT,
        wsPath: "/",
        httpPort: PORT,
        httpPath: "/",
        authRequired: AUTH_REQUIRED
      });
      sock.send(Buffer.from(payload, "utf-8"), rinfo.port, rinfo.address);
    });
    sock.bind(DISCOVERY_PORT, "0.0.0.0", () => {
      console.log(`[discovery] udp://0.0.0.0:${DISCOVERY_PORT} (responds to SENDPIPE_DISCOVER_V1)`);
    });
  }
});
