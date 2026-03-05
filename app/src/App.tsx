import type { DeviceId, DeviceType } from "@landrop/shared";
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

type IncomingShareRequest = {
  requestId: string;
  from: DeviceId;
  fromName: string;
  fromDeviceType?: DeviceType;
};

type ShareTarget = {
  deviceId: DeviceId;
  name: string;
  deviceType?: DeviceType;
};

type ReceivedReady = {
  fileId: string;
  name: string;
  size: number;
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
  const [pendingShareTarget, setPendingShareTarget] = useState<ShareTarget | null>(null);
  const [shareModalTarget, setShareModalTarget] = useState<ShareTarget | null>(null);
  const [shareModalFile, setShareModalFile] = useState<File | null>(null);
  const [shareModalSending, setShareModalSending] = useState(false);
  const [shareModalError, setShareModalError] = useState<string | null>(null);
  const [incomingOfferModal, setIncomingOfferModal] = useState<TransferSession["incomingOffer"] | null>(null);
  const [receivedReadyModal, setReceivedReadyModal] = useState<ReceivedReady | null>(null);
  const [activePeerId, setActivePeerId] = useState<DeviceId | null>(null);
  const [pc, setPc] = useState<PeerConnectionHandle | null>(null);
  const [dcStatus, setDcStatus] = useState<string>("disconnected");
  const [transfer, setTransfer] = useState<TransferSession | null>(null);

  const activePeerIdRef = useRef<DeviceId | null>(null);
  const pcRef = useRef<PeerConnectionHandle | null>(null);
  const deviceNameRef = useRef<string>(deviceName);
  const authRequiredRef = useRef<boolean>(false);
  const authTokenRef = useRef<string | null>(authToken);
  const presenceRef = useRef<PresenceDevice[]>([]);
  const approvedSharePeersRef = useRef<Set<DeviceId>>(new Set());

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
    deviceNameRef.current = deviceName;
  }, [deviceName]);

  useEffect(() => {
    authRequiredRef.current = authInfo?.authRequired ?? serverAuthRequired;
  }, [authInfo, serverAuthRequired]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

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
      onPairMatched: async () => {},
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
        if (response.accepted) {
          const peer = presenceRef.current.find((p) => p.deviceId === response.from);
          setPendingShareTarget({
            deviceId: response.from,
            name: peer?.name ?? "Peer",
            deviceType: peer?.deviceType
          });
          void connectToPeer(response.from);
        }
      }
    });

    const unsubAny = client.onAnySignal(async (from, signal) => {
      // Single active connection MVP: ignore signals from other peers while connected.
      const active = activePeerIdRef.current;
      if (active && from !== active) return;

      // Auto-answer offers from same-account peers, or explicitly approved share requests.
      const peerScope = presenceRef.current.find((d) => d.deviceId === from)?.scope;
      const allowByAccount = !!authTokenRef.current && peerScope === "mine";
      const allowByApprovedShare = approvedSharePeersRef.current.has(from);
      if (!pcRef.current && signal.type === "offer" && (allowByAccount || allowByApprovedShare)) {
        approvedSharePeersRef.current.delete(from);
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
    if (!transfer) return;
    const unsub = transfer.onEvent((event) => {
      if (event.type === "offer") setIncomingOfferModal(event.offer);
      if (event.type === "received_ready") {
        setReceivedReadyModal({ fileId: event.fileId, name: event.name, size: event.size });
      }
    });
    return () => unsub();
  }, [transfer]);

  useEffect(() => {
    if (!transfer || !pendingShareTarget || activePeerId !== pendingShareTarget.deviceId) return;
    setShareModalTarget(pendingShareTarget);
    setShareModalFile(null);
    setPendingShareTarget(null);
  }, [transfer, pendingShareTarget, activePeerId]);

  useEffect(() => {
    if (!serverAuthRequired || authToken) return;
    setPresence([]);
    void disconnect();
  }, [serverAuthRequired, authToken]);

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
    if (accepted) approvedSharePeersRef.current.add(request.from);
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

  async function startShareFlow(target: ShareTarget, kind: "mine" | "other") {
    setWsError(null);
    if (kind === "other") {
      requestShareTo(target.deviceId);
      return;
    }
    if (pc && activePeerId !== target.deviceId) await disconnect();
    if (!pc || activePeerId !== target.deviceId || !transfer) {
      setPendingShareTarget(target);
      await connectToPeer(target.deviceId);
      return;
    }
    setShareModalTarget(target);
    setShareModalFile(null);
  }

  async function sendFromShareModal() {
    if (!transfer || !shareModalFile) return;
    setShareModalError(null);
    setShareModalSending(true);
    try {
      await transfer.sendFile(shareModalFile);
      setShareModalTarget(null);
      setShareModalFile(null);
    } catch (e) {
      setShareModalError(String(e));
    } finally {
      setShareModalSending(false);
    }
  }

  function closeShareModal() {
    if (shareModalSending) return;
    setShareModalTarget(null);
    setShareModalFile(null);
    setShareModalError(null);
  }

  function closeIncomingOfferModal() {
    setIncomingOfferModal(null);
  }

  async function downloadReceivedModalFile() {
    if (!transfer || !receivedReadyModal) return;
    await transfer.saveReceived(receivedReadyModal.fileId);
    setReceivedReadyModal(null);
  }

  function dismissReceivedModalFile() {
    if (!transfer || !receivedReadyModal) return;
    transfer.discardReceived(receivedReadyModal.fileId);
    setReceivedReadyModal(null);
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
                <button
                  className="btn btn-primary"
                  disabled={!!pc && activePeerId !== peer.deviceId}
                  onClick={() =>
                    void startShareFlow(
                      { deviceId: peer.deviceId, name: peer.name, deviceType: peer.deviceType },
                      "mine"
                    )
                  }
                >
                  {activePeerId === peer.deviceId ? "Share" : "Share"}
                </button>
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
                  onClick={() =>
                    void startShareFlow(
                      { deviceId: peer.deviceId, name: peer.name, deviceType: peer.deviceType },
                      "other"
                    )
                  }
                >
                  {outgoingShareRequests[peer.deviceId] ? "Pending" : "Request"}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {shareModalTarget ? (
        <div className="modal-backdrop" onClick={closeShareModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Share</h3>
            <small className="muted">{shareModalTarget.name}</small>
            {transfer?.isReady() ? <small className="muted">Connection ready</small> : <small className="muted">Connecting…</small>}
            <div className="section-gap">
              <input
                type="file"
                onChange={(e) => setShareModalFile(e.target.files?.[0] ?? null)}
                disabled={shareModalSending}
              />
            </div>
            <div className="row section-gap">
              <button
                className="btn btn-primary"
                disabled={!shareModalFile || shareModalSending || !transfer?.isReady()}
                onClick={() => void sendFromShareModal()}
              >
                {shareModalSending ? "Uploading…" : "Upload"}
              </button>
              <button className="btn" onClick={closeShareModal} disabled={shareModalSending}>
                Close
              </button>
            </div>
            {shareModalError ? <small style={{ color: "tomato" }}>{shareModalError}</small> : null}
          </div>
        </div>
      ) : null}

      {incomingShareRequests[0] ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Incoming Request</h3>
            <small className="muted">{incomingShareRequests[0].fromName} wants to send data.</small>
            <div className="row section-gap">
              <button className="btn btn-primary" onClick={() => respondToShareRequest(incomingShareRequests[0], true)}>
                Approve
              </button>
              <button className="btn" onClick={() => respondToShareRequest(incomingShareRequests[0], false)}>
                Decline
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {incomingOfferModal ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Incoming File</h3>
            <small className="muted">{incomingOfferModal.name}</small>
            <small className="muted">{incomingOfferModal.size} bytes</small>
            <div className="row section-gap">
              <button
                className="btn btn-primary"
                onClick={() => {
                  transfer?.acceptOffer(incomingOfferModal.fileId);
                  closeIncomingOfferModal();
                }}
              >
                Accept
              </button>
              <button
                className="btn"
                onClick={() => {
                  transfer?.declineOffer(incomingOfferModal.fileId);
                  closeIncomingOfferModal();
                }}
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {receivedReadyModal ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Download File</h3>
            <small className="muted">{receivedReadyModal.name}</small>
            <small className="muted">{receivedReadyModal.size} bytes</small>
            <div className="row section-gap">
              <button className="btn btn-primary" onClick={() => void downloadReceivedModalFile()}>
                Download
              </button>
              <button className="btn" onClick={dismissReceivedModalFile}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
