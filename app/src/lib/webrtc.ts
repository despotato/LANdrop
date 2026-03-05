import type { IceCandidateInit } from "@sendpipe/shared";

type Signal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: IceCandidateInit };

type WebRtcOptions = {
  onSignal: (signal: Signal) => void;
  onConnectionState: (state: string) => void;
  onDataChannel: (channel: RTCDataChannel) => void;
};

export type PeerConnectionHandle = {
  startAsCaller(peerId: string): Promise<void>;
  handleSignal(peerId: string, signal: Signal): Promise<void>;
  close(): void;
};

const STUN: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function createPeerConnection(opts: WebRtcOptions): PeerConnectionHandle {
  const pc = new RTCPeerConnection({ iceServers: STUN });
  let dc: RTCDataChannel | null = null;

  pc.addEventListener("icecandidate", (ev) => {
    if (!ev.candidate) return;
    opts.onSignal({ type: "ice", candidate: ev.candidate.toJSON() });
  });

  pc.addEventListener("connectionstatechange", () => {
    opts.onConnectionState(pc.connectionState);
  });

  pc.addEventListener("datachannel", (ev) => {
    dc = ev.channel;
    wireDc(dc);
    opts.onDataChannel(dc);
  });

  function wireDc(channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => opts.onConnectionState("datachannel-open"));
    channel.addEventListener("close", () => opts.onConnectionState("datachannel-closed"));
  }

  async function startAsCaller(_peerId: string) {
    dc = pc.createDataChannel("sendpipe", { ordered: true });
    wireDc(dc);
    opts.onDataChannel(dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    opts.onSignal({ type: "offer", sdp: offer.sdp ?? "" });
  }

  async function handleSignal(_peerId: string, signal: Signal) {
    if (signal.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      opts.onSignal({ type: "answer", sdp: answer.sdp ?? "" });
      return;
    }

    if (signal.type === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      return;
    }

    if (signal.type === "ice") {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch {
        // ignore
      }
    }
  }

  return {
    startAsCaller,
    handleSignal,
    close: () => {
      try {
        dc?.close();
      } catch {
        // ignore
      }
      pc.close();
    }
  };
}
