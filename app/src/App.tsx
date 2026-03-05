import type { DeviceId } from "@sendpipe/shared";
import { deriveSafetyPhrase } from "@sendpipe/shared";
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
  publicKeyJwk: JsonWebKey;
  addedAtMs: number;
};

function loadTrustedPeers(): Record<DeviceId, TrustedPeer> {
  try {
    return JSON.parse(localStorage.getItem(storageKey("trustedPeers")) ?? "{}") as Record<DeviceId, TrustedPeer>;
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
  const [localEmail, setLocalEmail] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceDevice[]>([]);
  const [pairCode, setPairCode] = useState("");
  const [createdPairCode, setCreatedPairCode] = useState<string | null>(null);
  const [pendingPeer, setPendingPeer] = useState<TrustedPeer | null>(null);
  const [safetyPhrase, setSafetyPhrase] = useState<string | null>(null);

  const [trustedPeers, setTrustedPeers] = useState<Record<DeviceId, TrustedPeer>>(() => loadTrustedPeers());

  const [selectedPeerId, setSelectedPeerId] = useState<DeviceId | "">("");
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
    authRequiredRef.current = authInfo?.authRequired ?? false;
  }, [authInfo]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    if (!identity || !signalingUrl) return;
    if (serverAuthRequired && !authToken) return;
    const client = createWsClient({
      url: signalingUrl,
      identity,
      authToken,
      onPresence: setPresence,
      onError: (m) => setWsError(m),
      onWelcome: (w) => setAuthInfo(w),
      onPairMatched: async (peer) => {
        const phrase = await deriveSafetyPhrase(identity.publicKeyJwk, peer.publicKeyJwk);
        setPendingPeer({ ...peer, addedAtMs: Date.now() });
        setSafetyPhrase(phrase);
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
        setSelectedPeerId(from);

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
  }, [identity, authToken, signalingUrl, serverAuthRequired]);

  const peerChoices = useMemo(() => Object.values(trustedPeers), [trustedPeers]);
  const connectChoices = useMemo(() => {
    if (authInfo?.authRequired && authToken) {
      return presence.filter((d) => d.deviceId !== identity?.deviceId && d.online);
    }
    return peerChoices.map((p) => ({ deviceId: p.deviceId, name: p.name, online: true }));
  }, [authInfo?.authRequired, authToken, presence, peerChoices, identity?.deviceId]);

  async function onCreatePairCode() {
    setWsError(null);
    if (!identity) return;
    const client = getWsClient();
    const res = await client.pairCreate();
    if (res.ok) setCreatedPairCode(res.code);
    else setWsError(res.error);
  }

  async function onJoinPairCode() {
    setWsError(null);
    if (!pairCode.trim()) return;
    const client = getWsClient();
    const res = await client.pairJoin(pairCode.trim());
    if (!res.ok) setWsError(res.error);
  }

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
    try {
      const mod = await import("@tauri-apps/api/shell");
      await mod.open(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  useEffect(() => {
    if (!authFlow) return;
    let cancelled = false;

    async function loop() {
      while (!cancelled) {
        try {
          const res = await pollGoogleDeviceAuth(signalingHttpBase, authFlow.device_code);
          if (res.ok) {
            localStorage.setItem(storageKey("authToken"), res.sessionToken);
            setAuthToken(res.sessionToken);
            setAuthFlow(null);
            window.location.reload();
            return;
          }
          // pending/slow_down/etc
        } catch {
          // ignore; keep polling
        }
        await new Promise((r) => setTimeout(r, Math.max(2, authFlow.intervalSec) * 1000));
      }
    }

    void loop();
    return () => {
      cancelled = true;
    };
  }, [authFlow]);

  function logout() {
    localStorage.removeItem(storageKey("authToken"));
    setAuthToken(null);
    window.location.reload();
  }

  async function localDoLogin() {
    setWsError(null);
    const token = await derivePortableLocalToken(localEmail, localPassword);
    localStorage.setItem(storageKey("authToken"), token);
    setAuthToken(token);
    window.location.reload();
  }

  async function localDoSignup() {
    setWsError(null);
    const token = await derivePortableLocalToken(localEmail, localPassword);
    localStorage.setItem(storageKey("authToken"), token);
    setAuthToken(token);
    window.location.reload();
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

  async function disconnect() {
    pc?.close();
    transfer?.dispose();
    setPc(null);
    setTransfer(null);
    setDcStatus("disconnected");
    setActivePeerId(null);
  }

  if (!identity) return <div className="wrap">Loading…</div>;

  const onlineOtherDevices = presence.filter((d) => d.deviceId !== identity.deviceId);

  return (
    <div className="wrap">
      <h2>SendPipe</h2>

      <div className="card">
        <h3>Account</h3>
        <div className="row">
          <span className="pill">Auth: {authInfo?.authRequired ? "required" : "off"}</span>
          {serverAuthRequired && !authToken ? <span className="pill">Connect waits for sign-in</span> : null}
          {authToken ? (
            <>
              <span className="pill">Signed in</span>
              <button onClick={logout}>Sign out</button>
            </>
          ) : (
            <>
              <button onClick={startLogin} disabled={!!authFlow}>
                Sign in with Google
              </button>
              <input
                value={localEmail}
                onChange={(e) => setLocalEmail(e.target.value)}
                placeholder="Email"
                style={{ minWidth: 220 }}
              />
              <input
                value={localPassword}
                onChange={(e) => setLocalPassword(e.target.value)}
                placeholder="Password"
                type="password"
                style={{ minWidth: 220 }}
              />
              <button onClick={localDoLogin}>Sign in</button>
              <button onClick={localDoSignup}>Use this account</button>
            </>
          )}
          <small className="muted">Signaling: {signalingUrl ?? "…"}</small>
        </div>

        {authFlow ? (
          <div style={{ marginTop: 10 }}>
            <div className="row">
              <strong>Finish sign-in</strong>
              <span className="pill">Code: {authFlow.user_code}</span>
              <button onClick={() => openLoginUrl(authFlow.verification_url)}>Open Google login</button>
              <button onClick={() => setAuthFlow(null)}>Cancel</button>
            </div>
            <small className="muted">
              Enter the code in the browser window. This app will auto-detect when you finish.
            </small>
          </div>
        ) : null}

        {discoveryStatus ? (
          <div style={{ marginTop: 8 }}>
            <small className="muted">{discoveryStatus}</small>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="row">
          <strong>Device</strong>
          <span className="pill">{identity.deviceId.slice(0, 8)}</span>
          <input
            value={deviceName}
            onChange={(e) => {
              const name = e.target.value;
              setDeviceNameState(name);
              setDeviceName(name);
              getWsClient().updateHelloName(name);
            }}
            placeholder="Device name"
          />
          <small className="muted">Signaling: {signalingUrl ?? "…"}</small>
        </div>
        {wsError ? <p style={{ color: "tomato" }}>{wsError}</p> : null}
      </div>

      <div className="card">
        <h3>Pairing (optional)</h3>
        <div className="row">
          <button onClick={onCreatePairCode}>Create pairing code</button>
          {createdPairCode ? (
            <span>
              Code: <strong style={{ fontSize: 18 }}>{createdPairCode}</strong>
            </span>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="Enter code" />
          <button onClick={onJoinPairCode}>Join</button>
        </div>

        {pendingPeer ? (
          <div style={{ marginTop: 10 }}>
            <div className="row">
              <strong>Verify safety phrase</strong>
              <span className="pill">{pendingPeer.name}</span>
            </div>
            <p style={{ margin: "8px 0" }}>
              <code>{safetyPhrase ?? "…"}</code>
            </p>
            <div className="row">
              <button onClick={onTrustPeer}>Trust peer</button>
              <button
                onClick={() => {
                  setPendingPeer(null);
                  setSafetyPhrase(null);
                }}
              >
                Cancel
              </button>
            </div>
            <small className="muted">
              Note: this MVP does not yet sign/encrypt signaling; phrase is a user check.
            </small>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>Presence</h3>
        <ul>
          {onlineOtherDevices.map((d) => (
            <li key={d.deviceId}>
              {d.name} <small className="muted">({d.deviceId.slice(0, 8)})</small> {d.online ? "online" : "offline"}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Phase 2/3: Connect + Transfer</h3>
        <div className="row">
          <select value={selectedPeerId} onChange={(e) => setSelectedPeerId(e.target.value as any)}>
            <option value="">Select device…</option>
            {connectChoices.map((p) => (
              <option value={p.deviceId} key={p.deviceId}>
                {p.name} ({p.deviceId.slice(0, 6)})
              </option>
            ))}
          </select>
          <button disabled={!selectedPeerId || !!pc} onClick={() => connectToPeer(selectedPeerId as DeviceId)}>
            Connect
          </button>
          <button disabled={!pc} onClick={disconnect}>
            Disconnect
          </button>
          <span className="pill">Status: {dcStatus}</span>
        </div>

        {transfer ? <TransferUi transfer={transfer} /> : <small className="muted">Connect to send files.</small>}
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
          <button onClick={() => transfer.cancelTransfer(activeFileId)}>Cancel Transfer</button>
        ) : null}
      </div>

      {incomingOffer ? (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <strong>Incoming file:</strong> {incomingOffer.name} <span className="pill">{incomingOffer.size} bytes</span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              onClick={() => {
                transfer.acceptOffer(incomingOffer.fileId);
                setIncomingOffer(null);
              }}
            >
              Accept
            </button>
            <button
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
