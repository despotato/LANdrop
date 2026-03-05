import type {
  DeviceId,
  IceCandidateInit,
  WsClientHello,
  WsServerMessage,
  WsWebrtcAnswer,
  WsWebrtcIce,
  WsWebrtcOffer
} from "@landrop/shared";
import { isObject } from "@landrop/shared";
import type { LocalIdentity } from "./deviceIdentity.js";

export type PresenceDevice = {
  deviceId: DeviceId;
  name: string;
  online: boolean;
  lastSeenMs: number;
  findable: boolean;
  publicKeyJwk?: JsonWebKey;
};

export type PairMatchedPeer = { deviceId: DeviceId; name: string; publicKeyJwk: JsonWebKey };

type Signal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: IceCandidateInit };

type WsClientOptions = {
  url: string;
  identity: LocalIdentity;
  findable: boolean;
  authToken?: string | null;
  onPresence: (devices: PresenceDevice[]) => void;
  onPairMatched: (peer: PairMatchedPeer) => void;
  onError: (message: string) => void;
  onWelcome?: (welcome: { authRequired: boolean; user?: { sub: string; email?: string; name?: string; picture?: string } }) => void;
};

type PairResult = { ok: true; code: string } | { ok: false; error: string };

type JoinResult = { ok: true } | { ok: false; error: string };

type ClientHandle = {
  close(): void;
  pairCreate(): Promise<PairResult>;
  pairJoin(code: string): Promise<JoinResult>;
  updateHelloState(name: string, findable: boolean): void;
  sendSignal(peerId: DeviceId, signal: Signal): void;
  onSignalFromPeer(peerId: DeviceId, cb: (signal: Signal) => void): void;
  onAnySignal(cb: (from: DeviceId, signal: Signal) => void): () => void;
};

let singleton: ClientHandle | null = null;

export function getWsClient(): ClientHandle {
  if (!singleton) throw new Error("WS client not initialized");
  return singleton;
}

export function createWsClient(opts: WsClientOptions): ClientHandle {
  const ws = new WebSocket(opts.url);
  let closedByClient = false;
  let openResolve: (() => void) | null = null;
  const openPromise = new Promise<void>((resolve) => (openResolve = resolve));

  const signalListeners = new Map<DeviceId, Set<(signal: Signal) => void>>();
  const anySignalListeners = new Set<(from: DeviceId, signal: Signal) => void>();

  function emitSignal(from: DeviceId, signal: Signal) {
    const listeners = signalListeners.get(from);
    if (!listeners) return;
    for (const cb of listeners) cb(signal);
  }

  function emitAnySignal(from: DeviceId, signal: Signal) {
    for (const cb of anySignalListeners) cb(from, signal);
  }

  function send(msg: any) {
    ws.send(JSON.stringify(msg));
  }

  function hello(nameOverride?: string, findableOverride?: boolean) {
    const msg: WsClientHello = {
      type: "hello",
      deviceId: opts.identity.deviceId,
      name: nameOverride ?? opts.identity.name,
      publicKeyJwk: opts.identity.publicKeyJwk,
      authToken: opts.authToken ?? undefined,
      findable: findableOverride ?? opts.findable
    };
    send(msg);
  }

  ws.addEventListener("open", () => {
    hello();
    openResolve?.();
    openResolve = null;
  });

  ws.addEventListener("message", (ev) => {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMessage;
    } catch {
      return;
    }

    if (!isObject(msg) || typeof (msg as any).type !== "string") return;
    if (msg.type === "presence") opts.onPresence(msg.devices as PresenceDevice[]);
    if (msg.type === "error") opts.onError(msg.message);
    if (msg.type === "welcome") {
      opts.onWelcome?.({ authRequired: msg.authRequired, user: (msg as any).user });
    }
    if (msg.type === "pair.matched") opts.onPairMatched(msg.peer);

    if (msg.type === "webrtc.offer") {
      const m = msg as WsWebrtcOffer & { from: DeviceId };
      const signal = { type: "offer" as const, sdp: m.sdp };
      emitSignal(m.from, signal);
      emitAnySignal(m.from, signal);
    }
    if (msg.type === "webrtc.answer") {
      const m = msg as WsWebrtcAnswer & { from: DeviceId };
      const signal = { type: "answer" as const, sdp: m.sdp };
      emitSignal(m.from, signal);
      emitAnySignal(m.from, signal);
    }
    if (msg.type === "webrtc.ice") {
      const m = msg as WsWebrtcIce & { from: DeviceId };
      const signal = { type: "ice" as const, candidate: m.candidate };
      emitSignal(m.from, signal);
      emitAnySignal(m.from, signal);
    }
  });

  ws.addEventListener("close", () => {
    if (!closedByClient) opts.onError("Signaling disconnected");
  });
  ws.addEventListener("error", () => opts.onError("Signaling error"));

  const handle: ClientHandle = {
    close: () => {
      closedByClient = true;
      ws.close();
    },
    pairCreate: async () => {
      await openPromise;
      return await new Promise<PairResult>((resolve) => {
        const onMsg = (ev: MessageEvent) => {
          let msg: WsServerMessage;
          try {
            msg = JSON.parse(String(ev.data)) as WsServerMessage;
          } catch {
            return;
          }
          if (msg.type === "pair.created") {
            ws.removeEventListener("message", onMsg);
            resolve({ ok: true, code: msg.code });
          } else if (msg.type === "error") {
            ws.removeEventListener("message", onMsg);
            resolve({ ok: false, error: msg.message });
          }
        };
        ws.addEventListener("message", onMsg);
        send({ type: "pair.create" });
      });
    },
    pairJoin: async (code: string) => {
      await openPromise;
      return await new Promise<JoinResult>((resolve) => {
        const timeout = window.setTimeout(() => {
          ws.removeEventListener("message", onMsg);
          resolve({ ok: true });
        }, 5000);

        const onMsg = (ev: MessageEvent) => {
          let msg: WsServerMessage;
          try {
            msg = JSON.parse(String(ev.data)) as WsServerMessage;
          } catch {
            return;
          }
          if (msg.type === "pair.matched") {
            window.clearTimeout(timeout);
            ws.removeEventListener("message", onMsg);
            resolve({ ok: true });
          } else if (msg.type === "error") {
            window.clearTimeout(timeout);
            ws.removeEventListener("message", onMsg);
            resolve({ ok: false, error: msg.message });
          }
        };

        ws.addEventListener("message", onMsg);
        send({ type: "pair.join", code });
      });
    },
    updateHelloState: (name, findable) => {
      if (ws.readyState !== ws.OPEN) return;
      hello(name, findable);
    },
    sendSignal: (peerId, signal) => {
      if (ws.readyState !== ws.OPEN) return;
      if (signal.type === "offer") send({ type: "webrtc.offer", to: peerId, sdp: signal.sdp });
      if (signal.type === "answer") send({ type: "webrtc.answer", to: peerId, sdp: signal.sdp });
      if (signal.type === "ice") send({ type: "webrtc.ice", to: peerId, candidate: signal.candidate });
    },
    onSignalFromPeer: (peerId, cb) => {
      const set = signalListeners.get(peerId) ?? new Set();
      set.add(cb);
      signalListeners.set(peerId, set);
    },
    onAnySignal: (cb) => {
      anySignalListeners.add(cb);
      return () => anySignalListeners.delete(cb);
    }
  };

  singleton = handle;
  return handle;
}
