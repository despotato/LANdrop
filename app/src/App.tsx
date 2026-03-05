import type { DeviceId, DeviceType } from "@landrop/shared";
import { deriveSafetyPhrase } from "@landrop/shared";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { getOrCreateIdentity, setDeviceName, type LocalIdentity } from "./lib/deviceIdentity.js";
import { storageKey } from "./lib/storage.js";
import {
  getSignalingHttpBase,
  derivePortableLocalToken,
  pollGoogleDeviceAuth,
  startGoogleDeviceAuth
} from "./lib/authClient.js";
import { discoverSignaling } from "./lib/discoveryClient.js";
import { ensureSignaling } from "./lib/ensureSignalingClient.js";
import { createWsClient, getWsClient, type PresenceDevice } from "./lib/wsClient.js";
import { createPeerConnection, type PeerConnectionHandle } from "./lib/webrtc.js";
import { createTransferSession, type TransferSession } from "./lib/transfer.js";

const ENV_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL as string | undefined;
const ENV_SIGNALING_HTTP = import.meta.env.VITE_SIGNALING_HTTP_URL as string | undefined;
const DEFAULT_SIGNALING_URL = ENV_SIGNALING_URL ?? "ws://localhost:8787";
const DEFAULT_SIGNALING_HTTP = ENV_SIGNALING_HTTP ?? getSignalingHttpBase(DEFAULT_SIGNALING_URL);

type TrustedPeer = {
  deviceId: DeviceId;
  name: string;
  deviceType?: DeviceType;
  publicKeyJwk: JsonWebKey;
  addedAtMs: number;
};

type IncomingShareRequest = {
  requestId: string;
  from: DeviceId;
  fromName: string;
  fromDeviceType?: DeviceType;
};

const DEVICE_ICON: Record<DeviceType, string> = {
  windows: "🪟",
  macos: "🍎",
  linux: "🐧",
  android: "🤖",
  ios: "📱",
  web: "🌐",
  unknown: "💻"
};

function deviceTypeLabel(deviceType?: DeviceType): string {
  if (!deviceType) return "Unknown";
  if (deviceType === "ios") return "iOS";
  if (deviceType === "macos") return "macOS";
  return deviceType.charAt(0).toUpperCase() + deviceType.slice(1);
}

function loadTrustedPeers(): Record<DeviceId, TrustedPeer> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey("trustedPeers")) ?? "{}") as Record<DeviceId, TrustedPeer>;
    const normalized: Record<DeviceId, TrustedPeer> = {};
    for (const [deviceId, peer] of Object.entries(parsed)) {
      normalized[deviceId] = { ...peer, deviceType: peer.deviceType ?? "unknown" };
    }
    return normalized;
  } catch {
    return {};
  }
}

function saveTrustedPeers(peers: Record<DeviceId, TrustedPeer>) {
  localStorage.setItem(storageKey("trustedPeers"), JSON.stringify(peers));
}

export default function App() {
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [deviceName, setDeviceNameState] = useState<string>("");
  const [findable, setFindable] = useState<boolean>(() => {
    const raw = localStorage.getItem(storageKey("findable"));
    return raw === null ? true : raw === "1";
  });
  const [signalingUrl, setSignalingUrl] = useState<string | null>(ENV_SIGNALING_URL ?? null);
  const [signalingHttpBase, setSignalingHttpBase] = useState<string>(DEFAULT_SIGNALING_HTTP);
  const [discoveryStatus, setDiscoveryStatus] = useState<string | null>(null);
  const [serverAuthRequired, setServerAuthRequired] = useState<boolean>(false);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(storageKey("authToken")));
  const [authInfo, setAuthInfo] = useState<{ authRequired: boolean; user?: any } | null>(null);
  const [authFlow, setAuthFlow] = useState<{
    device_code: string;
    user_code: string;
    verification_url: string;
    intervalSec: number;
  } | null>(null);
  const [localEmail, setLocalEmail] = useState<string>(() => localStorage.getItem(storageKey("localEmail")) ?? "");
  const [localPassword, setLocalPassword] = useState<string>(() => localStorage.getItem(storageKey("localPassword")) ?? "");
  const [wsError, setWsError] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceDevice[]>([]);
  const [incomingShareRequests, setIncomingShareRequests] = useState<IncomingShareRequest[]>([]);
  const [outgoingShareRequests, setOutgoingShareRequests] = useState<Record<DeviceId, string>>({});
  const [pendingPeer, setPendingPeer] = useState<TrustedPeer | null>(null);
  const [safetyPhrase, setSafetyPhrase] = useState<string | null>(null);

  const [trustedPeers, setTrustedPeers] = useState<Record<DeviceId, TrustedPeer>>(() => loadTrustedPeers());

  const [activePeerId, setActivePeerId] = useState<DeviceId | null>(null);
  const [pc, setPc] = useState<PeerConnectionHandle | null>(null);
  const [dcStatus, setDcStatus] = useState<string>("disconnected");
  const [transfer, setTransfer] = useState<TransferSession | null>(null);

  const activePeerIdRef = useRef<DeviceId | null>(null);
  const pcRef = useRef<PeerConnectionHandle | null>(null);
  const trustedPeersRef = useRef<Record<DeviceId, TrustedPeer>>(trustedPeers);
  const deviceNameRef = useRef<string>(deviceName);
  const authRequiredRef = useRef<boolean>(false);
  const authTokenRef = useRef<string | null>(authToken);

  useEffect(() => {
    getOrCreateIdentity().then((id) => {
      setIdentity(id);
      setDeviceNameState(id.name);
    });
  }, []);

  useEffect(() => {
    if (ENV_SIGNALING_URL) {
      setSignalingUrl(ENV_SIGNALING_URL);
      setSignalingHttpBase(DEFAULT_SIGNALING_HTTP);
      setServerAuthRequired(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setDiscoveryStatus("Finding signaling server…");

      // Tauri: ensure a server exists (discover, else start embedded)
      const ensured = await ensureSignaling();
      if (cancelled) return;
      if (ensured) {
        setSignalingUrl(ensured.ws_url);
        setSignalingHttpBase(ensured.http_url);
        setServerAuthRequired(ensured.auth_required);
        setDiscoveryStatus(
          ensured.started ? `Started local signaling: ${ensured.ws_url}` : `Using LAN signaling: ${ensured.ws_url}`
        );
        return;
      }

      // Web dev fallback: discovery only (no embedded server)
      const found = await discoverSignaling();
      if (cancelled) return;
      if (found && found.length > 0) {
        setSignalingUrl(found[0].ws_url);
        setSignalingHttpBase(found[0].http_url);
        setServerAuthRequired(found[0].auth_required);
        setDiscoveryStatus(`Using LAN signaling: ${found[0].ws_url}`);
        return;
      }

      setSignalingUrl(DEFAULT_SIGNALING_URL);
      setSignalingHttpBase(DEFAULT_SIGNALING_HTTP);
      setServerAuthRequired(false);
      setDiscoveryStatus("LAN signaling not found; using default signaling.");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    activePeerIdRef.current = activePeerId;
  }, [activePeerId]);

  useEffect(() => {
    pcRef.current = pc;
  }, [pc]);

  useEffect(() => {
    trustedPeersRef.current = trustedPeers;
  }, [trustedPeers]);

  useEffect(() => {
    deviceNameRef.current = deviceName;
  }, [deviceName]);

  useEffect(() => {
    authRequiredRef.current = authInfo?.authRequired ?? serverAuthRequired;
  }, [authInfo, serverAuthRequired]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    localStorage.setItem(storageKey("localEmail"), localEmail);
  }, [localEmail]);

  useEffect(() => {
    localStorage.setItem(storageKey("localPassword"), localPassword);
  }, [localPassword]);

  useEffect(() => {
    setAuthInfo((prev) => (prev ? { ...prev, authRequired: serverAuthRequired } : { authRequired: serverAuthRequired }));
  }, [serverAuthRequired]);

  useEffect(() => {
    if (!identity || !signalingUrl) return;
    const client = createWsClient({
      url: signalingUrl,
      identity,
      findable,
      authToken,
      onPresence: setPresence,
      onError: (m) => setWsError(m),
      onWelcome: (w) => setAuthInfo(w),
      onPairMatched: async (peer) => {
        const phrase = await deriveSafetyPhrase(identity.publicKeyJwk, peer.publicKeyJwk);
        setPendingPeer({ ...peer, addedAtMs: Date.now() });
        setSafetyPhrase(phrase);
      },
      onShareRequest: (request) => {
        setIncomingShareRequests((existing) => {
          if (existing.some((r) => r.requestId === request.requestId)) return existing;
          return [request, ...existing].slice(0, 20);
        });
      },
      onShareResponse: (response) => {
        setOutgoingShareRequests((existing) => {
          const next = { ...existing };
          delete next[response.from];
          return next;
        });
        if (response.accepted) void connectToPeer(response.from);
      }
    });

    const unsubAny = client.onAnySignal(async (from, signal) => {
      // Single active connection MVP: ignore signals from other peers while connected.
      const active = activePeerIdRef.current;
      if (active && from !== active) return;

      // Auto-answer offers from trusted peers.
      const allowByAccount = authRequiredRef.current && !!authTokenRef.current;
      const allowByTrust = !!trustedPeersRef.current[from];
      if (!pcRef.current && signal.type === "offer" && (allowByTrust || allowByAccount)) {
        setActivePeerId(from);

        const handle = createPeerConnection({
          onSignal: (s) => client.sendSignal(from, s),
          onConnectionState: (s) => setDcStatus(s),
          onDataChannel: (dc) => {
            setDcStatus("datachannel-open");
            const session = createTransferSession({
              localDeviceId: identity.deviceId,
              localName: deviceNameRef.current,
              dataChannel: dc
            });
            setTransfer(session);
          }
        });
        pcRef.current = handle;
        setPc(handle);

        client.onSignalFromPeer(from, async (sig) => {
          await handle.handleSignal(from, sig);
        });
        await handle.handleSignal(from, signal);
      }
    });

    return () => {
      unsubAny();
      client.close();
    };
  }, [identity, authToken, signalingUrl, serverAuthRequired, findable]);

  useEffect(() => {
    if (!serverAuthRequired || authToken) return;
    setPresence([]);
    void disconnect();
  }, [serverAuthRequired, authToken]);

  const peerChoices = useMemo(() => Object.values(trustedPeers), [trustedPeers]);
  const authRequired = authInfo?.authRequired ?? serverAuthRequired;
  const myDeviceChoices = useMemo(() => {
    if (!authToken) return [];
    return presence.filter((d) => d.scope === "mine" && d.deviceId !== identity?.deviceId && d.online);
  }, [authToken, presence, identity?.deviceId]);
  const otherUserChoices = useMemo(() => {
    return presence.filter((d) => d.scope !== "mine" && d.deviceId !== identity?.deviceId && d.online && d.findable);
  }, [presence, identity?.deviceId]);

  async function startLogin() {
    setWsError(null);
    const res = await startGoogleDeviceAuth(signalingHttpBase);
    if (!res.ok) {
      setWsError(res.error);
      return;
    }
    setAuthFlow({
      device_code: res.start.device_code,
      user_code: res.start.user_code,
      verification_url: res.start.verification_url,
      intervalSec: res.start.interval ?? 5
    });
  }

  async function openLoginUrl(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  useEffect(() => {
    if (!authFlow) return;
    let cancelled = false;
    const flow = authFlow;

    async function loop() {
      while (!cancelled) {
        try {
          const res = await pollGoogleDeviceAuth(signalingHttpBase, flow.device_code);
          if (res.ok) {
            localStorage.setItem(storageKey("authToken"), res.sessionToken);
            setAuthToken(res.sessionToken);
            setAuthFlow(null);
            return;
          }
          // pending/slow_down/etc
        } catch {
          // ignore; keep polling
        }
        await new Promise((r) => setTimeout(r, Math.max(2, flow.intervalSec) * 1000));
      }
    }

    void loop();
    return () => {
      cancelled = true;
    };
  }, [authFlow]);

  async function logout() {
    await disconnect();
    setPresence([]);
    setWsError(null);
    setAuthFlow(null);
    localStorage.removeItem(storageKey("authToken"));
    setAuthToken(null);
  }

  async function localDoLogin() {
    setWsError(null);
    if (!localEmail.trim() || !localPassword) {
      setWsError("Enter email and password.");
      return;
    }
    const token = await derivePortableLocalToken(localEmail, localPassword);
    localStorage.setItem(storageKey("authToken"), token);
    setAuthToken(token);
  }

  async function localDoSignup() {
    setWsError(null);
    if (!localEmail.trim() || !localPassword) {
      setWsError("Enter email and password.");
      return;
    }
    const token = await derivePortableLocalToken(localEmail, localPassword);
    localStorage.setItem(storageKey("authToken"), token);
    setAuthToken(token);
  }

  async function onTrustPeer() {
    if (!pendingPeer) return;
    const next = { ...trustedPeers, [pendingPeer.deviceId]: pendingPeer };
    setTrustedPeers(next);
    saveTrustedPeers(next);
    setPendingPeer(null);
    setSafetyPhrase(null);
  }

  async function connectToPeer(peerId: DeviceId) {
    if (!identity) return;
    const ws = getWsClient();
    setActivePeerId(peerId);
    const handle = createPeerConnection({
      onSignal: (signal) => ws.sendSignal(peerId, signal),
      onConnectionState: (s) => setDcStatus(s),
      onDataChannel: (dc) => {
        setDcStatus("datachannel-open");
        const session = createTransferSession({
          localDeviceId: identity.deviceId,
          localName: deviceNameRef.current,
          dataChannel: dc
        });
        setTransfer(session);
      }
    });

    ws.onSignalFromPeer(peerId, async (signal) => {
      await handle.handleSignal(peerId, signal);
    });

    setPc(handle);
    await handle.startAsCaller(peerId);
  }

  function requestShareTo(peerId: DeviceId) {
    const ws = getWsClient();
    const requestId = crypto.randomUUID();
    setOutgoingShareRequests((existing) => ({ ...existing, [peerId]: requestId }));
    ws.sendShareRequest(peerId, requestId);
  }

  function respondToShareRequest(request: IncomingShareRequest, accepted: boolean) {
    const ws = getWsClient();
    ws.sendShareResponse(request.from, request.requestId, accepted);
    setIncomingShareRequests((existing) => existing.filter((r) => r.requestId !== request.requestId));
  }

  async function onAuthPrimaryClick() {
    if (authToken) {
      await logout();
      return;
    }
    await localDoLogin();
  }

  async function disconnect() {
    pc?.close();
    transfer?.dispose();
    setPc(null);
    setTransfer(null);
    setDcStatus("disconnected");
    setActivePeerId(null);
  }

  async function disconnectDevice(peerId: DeviceId) {
    if (activePeerId !== peerId) return;
    await disconnect();
  }

  async function forgetDevice(peerId: DeviceId) {
    if (activePeerId === peerId) await disconnect();
    const next = { ...trustedPeers };
    delete next[peerId];
    setTrustedPeers(next);
    saveTrustedPeers(next);
  }

  if (!identity) return <div className="wrap">Loading…</div>;

  return (
    <div className="wrap app-shell compact-shell">
      <header className="hero">
        <h2>LANdrop</h2>
        {discoveryStatus ? <small className="muted hero-status">{discoveryStatus}</small> : null}
      </header>

      <div className="card compact-strip">
        <div className="top-strip-row">
          <div className="top-group">
            <span className="pill">ID {identity.deviceId.slice(0, 6)}</span>
            <input
              className="device-input"
              value={deviceName}
              onChange={(e) => {
                const name = e.target.value;
                setDeviceNameState(name);
                setDeviceName(name);
                getWsClient().updateHelloState(name, findable);
              }}
              placeholder="Device"
            />
            <button
              className={`toggle ${findable ? "is-on" : ""}`}
              onClick={() => {
                const next = !findable;
                setFindable(next);
                localStorage.setItem(storageKey("findable"), next ? "1" : "0");
                try {
                  getWsClient().updateHelloState(deviceName, next);
                } catch {}
              }}
            >
              <span className="toggle-dot" />
              <span>{findable ? "Findable" : "Hidden"}</span>
            </button>
          </div>
          <div className="top-group top-actions">
            {authToken ? (
              <>
                <button className="btn btn-ghost" onClick={onAuthPrimaryClick}>
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-primary" onClick={onAuthPrimaryClick}>
                  Sign in
                </button>
                <button className="btn" onClick={startLogin} disabled={!!authFlow}>
                  Google
                </button>
              </>
            )}
            <button className="btn" disabled={!pc} onClick={disconnect}>
              {pc ? "Disconnect" : "Disconnected"}
            </button>
          </div>
        </div>
        {!authToken ? (
          <div className="row section-gap top-auth-row">
            <input className="control-input" value={localEmail} onChange={(e) => setLocalEmail(e.target.value)} placeholder="Email" />
            <input
              className="control-input"
              value={localPassword}
              onChange={(e) => setLocalPassword(e.target.value)}
              placeholder="Password"
              type="password"
            />
          </div>
        ) : null}
        {authFlow ? (
          <div className="row section-gap">
            <span className="pill">{authFlow.user_code}</span>
            <button className="btn btn-primary" onClick={() => openLoginUrl(authFlow.verification_url)}>
              Open Login
            </button>
            <button className="btn" onClick={() => setAuthFlow(null)}>
              Cancel
            </button>
          </div>
        ) : null}
        {wsError ? (
          <div className="top-alert">
            <span className="pill pill-error">⚠</span>
            <small className="muted" style={{ color: "tomato" }}>
              {wsError}
            </small>
          </div>
        ) : null}
      </div>

      <div className="panel-grid">
        <section className="card panel">
          <div className="panel-head">
            <h3>My Devices</h3>
            <span className="pill">{myDeviceChoices.length}</span>
          </div>
          {!authToken ? <small className="muted note">Sign in to load devices.</small> : null}
          <div className="device-grid section-gap">
            {myDeviceChoices.map((peer) => (
              <div className={`device-card ${activePeerId === peer.deviceId ? "is-active" : ""}`} key={peer.deviceId}>
                <div className="device-inline">
                  <span className="device-icon" aria-hidden>
                    {DEVICE_ICON[peer.deviceType ?? "unknown"]}
                  </span>
                  <div>
                    <div>{peer.name}</div>
                    <small className="muted">{peer.deviceId.slice(0, 8)}</small>
                  </div>
                </div>
                {activePeerId === peer.deviceId ? (
                  <span className="pill">Connected</span>
                ) : (
                  <button className="btn btn-primary" disabled={!!pc} onClick={() => connectToPeer(peer.deviceId)}>
                    Connect
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="card panel">
          <div className="panel-head">
            <h3>Other Users</h3>
            <span className="pill">{otherUserChoices.length}</span>
          </div>
          <div className="device-grid section-gap">
            {otherUserChoices.map((peer) => (
              <div className="device-card" key={peer.deviceId}>
                <div className="device-inline">
                  <span className="device-icon" aria-hidden>
                    {DEVICE_ICON[peer.deviceType ?? "unknown"]}
                  </span>
                  <div>
                    <div>{peer.name}</div>
                    <small className="muted">{deviceTypeLabel(peer.deviceType)}</small>
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  disabled={!!pc || !!outgoingShareRequests[peer.deviceId]}
                  onClick={() => requestShareTo(peer.deviceId)}
                >
                  {outgoingShareRequests[peer.deviceId] ? "Pending" : "Request"}
                </button>
              </div>
            ))}
          </div>

          {incomingShareRequests.length > 0 ? (
            <ul className="list section-gap">
              {incomingShareRequests.map((request) => (
                <li className="list-item" key={request.requestId}>
                  <span className="device-inline">
                    <span className="device-icon" aria-hidden>
                      {DEVICE_ICON[request.fromDeviceType ?? "unknown"]}
                    </span>
                    <span>{request.fromName}</span>
                  </span>
                  <span className="row">
                    <button className="btn btn-primary" onClick={() => respondToShareRequest(request, true)}>
                      ✓
                    </button>
                    <button className="btn" onClick={() => respondToShareRequest(request, false)}>
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="section-gap">{transfer ? <TransferUi transfer={transfer} /> : null}</div>
        </section>
      </div>
    </div>
  );
}

function TransferUi({ transfer }: { transfer: TransferSession }) {
  const [log, setLog] = useState<string[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<TransferSession["incomingOffer"] | null>(null);
  const [progress, setProgress] = useState<{ fileId: string; sent: number; total: number } | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("idle");
  const [phaseDetail, setPhaseDetail] = useState<string>("");

  useEffect(() => {
    const unsub = transfer.onEvent((e) => {
      if (e.type === "log") setLog((l) => [e.message, ...l].slice(0, 50));
      if (e.type === "offer") setIncomingOffer(e.offer);
      if (e.type === "progress") setProgress({ fileId: e.fileId, sent: e.sentBytes, total: e.totalBytes });
      if (e.type === "status") {
        setActiveFileId(e.fileId);
        setPhase(e.phase);
        setPhaseDetail(e.detail ?? "");
        if (e.phase === "done" || e.phase === "cancelled" || e.phase === "failed") {
          setProgress(null);
        }
      }
      if (e.type === "error") {
        setActiveFileId(e.fileId);
        setPhase("failed");
        setPhaseDetail(e.message);
      }
      if (e.type === "done") {
        setProgress(null);
      }
    });
    return () => unsub();
  }, [transfer]);

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row">
        <input
          type="file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              await transfer.sendFile(f);
            } catch (err) {
              setLog((l) => [`Send failed: ${String(err)}`, ...l].slice(0, 50));
            }
            e.currentTarget.value = "";
          }}
        />
        {activeFileId && (phase === "pending_accept" || phase === "sending" || phase === "receiving") ? (
          <button className="btn" onClick={() => transfer.cancelTransfer(activeFileId)}>
            Cancel Transfer
          </button>
        ) : null}
      </div>

      {incomingOffer ? (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <strong>Incoming file:</strong> {incomingOffer.name} <span className="pill">{incomingOffer.size} bytes</span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn btn-primary"
              onClick={() => {
                transfer.acceptOffer(incomingOffer.fileId);
                setIncomingOffer(null);
              }}
            >
              Accept
            </button>
            <button
              className="btn"
              onClick={() => {
                transfer.declineOffer(incomingOffer.fileId);
                setIncomingOffer(null);
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ) : null}

      {progress ? (
        <p style={{ marginTop: 10 }}>
          Progress: {Math.floor((progress.sent / Math.max(1, progress.total)) * 100)}% ({progress.sent}/{progress.total})
        </p>
      ) : null}

      <p style={{ marginTop: 10 }}>
        Phase: <span className="pill">{phase}</span> {phaseDetail ? <small className="muted">{phaseDetail}</small> : null}
      </p>

      <details style={{ marginTop: 10 }}>
        <summary>Logs</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
      </details>
    </div>
  );
}
