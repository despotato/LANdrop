import type { DcControlMessage, DcFileOffer, FileId } from "@sendpipe/shared";
import { packFileChunk, unpackFileChunk } from "@sendpipe/shared";

type Offer = DcFileOffer;
type TransferPhase = "idle" | "offered" | "pending_accept" | "sending" | "receiving" | "done" | "failed" | "cancelled";

type TransferEvent =
  | { type: "log"; message: string }
  | { type: "offer"; offer: Offer }
  | { type: "status"; fileId: FileId; phase: TransferPhase; detail?: string }
  | { type: "progress"; fileId: FileId; sentBytes: number; totalBytes: number }
  | { type: "done"; fileId: FileId }
  | { type: "received"; fileId: FileId; name: string; size: number }
  | { type: "error"; fileId: FileId; message: string };

type Listener = (e: TransferEvent) => void;

type IncomingState = {
  offer: Offer;
  accepted: boolean;
  chunks: Map<number, Uint8Array>;
  receivedBytes: number;
  phase: TransferPhase;
};

type OutgoingState = {
  offer: Offer;
  accepted: boolean | null;
  resolveAccept: (v: boolean) => void;
  acceptPromise: Promise<boolean>;
  phase: TransferPhase;
  cancelled: boolean;
  acceptTimeoutId: number | null;
};

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const BUFFERED_MAX = 8 * 1024 * 1024;
const BUFFERED_LOW = 1 * 1024 * 1024;
const ACCEPT_TIMEOUT_MS = 15_000;

export type TransferSession = {
  incomingOffer: Offer | null;
  onEvent(cb: Listener): () => void;
  sendFile(file: File): Promise<void>;
  acceptOffer(fileId: FileId): void;
  declineOffer(fileId: FileId): void;
  cancelTransfer(fileId: FileId): void;
  dispose(): void;
};

export function createTransferSession(opts: {
  localDeviceId: string;
  localName: string;
  dataChannel: RTCDataChannel;
}): TransferSession {
  const listeners = new Set<Listener>();
  const incoming = new Map<FileId, IncomingState>();
  const outgoing = new Map<FileId, OutgoingState>();
  let incomingOffer: Offer | null = null;

  function emit(e: TransferEvent) {
    for (const cb of listeners) cb(e);
  }

  function sendControl(msg: DcControlMessage) {
    opts.dataChannel.send(JSON.stringify(msg));
  }

  function log(message: string) {
    emit({ type: "log", message });
  }

  function status(fileId: FileId, phase: TransferPhase, detail?: string) {
    emit({ type: "status", fileId, phase, detail });
  }

  function fail(fileId: FileId, message: string) {
    emit({ type: "error", fileId, message });
    status(fileId, "failed", message);
    log(message);
  }

  async function waitForBackpressure() {
    if (opts.dataChannel.bufferedAmount <= BUFFERED_MAX) return;
    opts.dataChannel.bufferedAmountLowThreshold = BUFFERED_LOW;
    await new Promise<void>((resolve) => {
      const onLow = () => {
        opts.dataChannel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      opts.dataChannel.addEventListener("bufferedamountlow", onLow);
    });
  }

  function handleControl(msg: DcControlMessage) {
    switch (msg.type) {
      case "HELLO":
        log(`DataChannel HELLO from ${msg.name} (${msg.deviceId.slice(0, 8)})`);
        return;
      case "FILE_OFFER": {
        if (incomingOffer) {
          sendControl({ type: "DECLINE", fileId: msg.fileId });
          log(`Declined ${msg.fileId}: another incoming offer is active`);
          return;
        }
        incomingOffer = msg;
        incoming.set(msg.fileId, {
          offer: msg,
          accepted: false,
          chunks: new Map(),
          receivedBytes: 0,
          phase: "offered"
        });
        emit({ type: "offer", offer: msg });
        status(msg.fileId, "offered", "Incoming offer");
        log(`Offer: ${msg.name} (${msg.size} bytes)`);
        return;
      }
      case "ACCEPT": {
        log(`Receiver accepted ${msg.fileId}`);
        const out = outgoing.get(msg.fileId);
        if (out && out.accepted === null) {
          out.accepted = true;
          out.phase = "sending";
          if (out.acceptTimeoutId !== null) window.clearTimeout(out.acceptTimeoutId);
          out.resolveAccept(true);
          status(msg.fileId, "sending", "Receiver accepted");
        }
        return;
      }
      case "DECLINE": {
        log(`Receiver declined ${msg.fileId}`);
        const out = outgoing.get(msg.fileId);
        if (out && out.accepted === null) {
          out.accepted = false;
          out.phase = "cancelled";
          if (out.acceptTimeoutId !== null) window.clearTimeout(out.acceptTimeoutId);
          out.resolveAccept(false);
          status(msg.fileId, "cancelled", "Receiver declined");
        }
        return;
      }
      case "CANCEL": {
        const out = outgoing.get(msg.fileId);
        if (out) {
          out.cancelled = true;
          if (out.accepted === null) {
            out.accepted = false;
            if (out.acceptTimeoutId !== null) window.clearTimeout(out.acceptTimeoutId);
            out.resolveAccept(false);
          }
          out.phase = "cancelled";
          status(msg.fileId, "cancelled", msg.reason ?? "Peer cancelled");
          log(`Transfer cancelled by peer: ${msg.fileId}`);
          outgoing.delete(msg.fileId);
        }

        const inc = incoming.get(msg.fileId);
        if (inc) {
          incoming.delete(msg.fileId);
          if (incomingOffer?.fileId === msg.fileId) incomingOffer = null;
          status(msg.fileId, "cancelled", msg.reason ?? "Peer cancelled");
          log(`Incoming transfer cancelled: ${msg.fileId}`);
        }
        return;
      }
      case "CHUNK_ACK":
        // Phase 4: could track retries / pacing.
        return;
      case "DONE":
        log(`Sender done ${msg.fileId}`);
        return;
      case "CLIPBOARD_TEXT":
        log(`Clipboard (stub): ${msg.text.slice(0, 80)}`);
        return;
      default:
        return;
    }
  }

  async function finalizeIncoming(fileId: FileId) {
    const state = incoming.get(fileId);
    if (!state) return;
    const { offer, chunks } = state;
    const totalChunks = Math.ceil(offer.size / offer.chunkSize);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const c = chunks.get(i);
      if (!c) {
        fail(fileId, `Missing chunk ${i}/${totalChunks} for ${fileId}`);
        return;
      }
      parts.push(c);
    }

    // Prefer native save (Tauri), fallback to browser download.
    const bytes = concat(parts);
    const saved = await trySaveToDownloads(offer.name, bytes);
    if (saved) {
      log(`Saved to ${saved.path}`);
    } else {
      const blob = new Blob([bytes], { type: offer.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = offer.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    emit({ type: "received", fileId, name: offer.name, size: offer.size });
    status(fileId, "done", "Received and saved");
    log(`Received ${offer.name}`);
    incoming.delete(fileId);
    incomingOffer = null;
  }

  opts.dataChannel.addEventListener("message", async (ev) => {
    if (typeof ev.data === "string") {
      let msg: DcControlMessage;
      try {
        msg = JSON.parse(ev.data) as DcControlMessage;
      } catch {
        return;
      }
      handleControl(msg);
      if (msg.type === "DONE") await finalizeIncoming(msg.fileId);
      return;
    }

    if (ev.data instanceof ArrayBuffer) {
      const { fileId, chunkIndex, payload } = unpackFileChunk(ev.data);
      const state = incoming.get(fileId);
      if (!state) return;
      if (!state.accepted) return;
      if (state.phase !== "receiving") return;

      const payloadBytes = new Uint8Array(payload);
      state.chunks.set(chunkIndex, payloadBytes);
      state.receivedBytes += payloadBytes.byteLength;
      sendControl({ type: "CHUNK_ACK", fileId, index: chunkIndex });
      emit({ type: "progress", fileId, sentBytes: state.receivedBytes, totalBytes: state.offer.size });
    }
  });

  opts.dataChannel.addEventListener("open", () => {
    sendControl({ type: "HELLO", deviceId: opts.localDeviceId, name: opts.localName });
  });

  opts.dataChannel.addEventListener("close", () => {
    for (const [fileId, out] of outgoing) {
      if (out.accepted === null) out.resolveAccept(false);
      status(fileId, "failed", "DataChannel closed");
      outgoing.delete(fileId);
    }
    for (const [fileId] of incoming) {
      status(fileId, "failed", "DataChannel closed");
      incoming.delete(fileId);
    }
    incomingOffer = null;
  });

  async function sendFile(file: File) {
    if (opts.dataChannel.readyState !== "open") {
      throw new Error("DataChannel is not open");
    }
    if (outgoing.size > 0) {
      throw new Error("Another transfer is already in progress");
    }

    const fileId = crypto.randomUUID() as FileId;
    const offer: DcFileOffer = {
      type: "FILE_OFFER",
      fileId,
      name: file.name,
      size: file.size,
      chunkSize: DEFAULT_CHUNK_SIZE,
      mimeType: file.type || "application/octet-stream"
    };
    sendControl(offer);
    status(fileId, "pending_accept", "Waiting for receiver acceptance");
    log(`Sent offer for ${file.name} (${file.size} bytes)`);

    const out: OutgoingState = {
      offer,
      accepted: null,
      resolveAccept: () => {},
      acceptPromise: Promise.resolve(false),
      phase: "pending_accept",
      cancelled: false,
      acceptTimeoutId: null
    };
    out.acceptPromise = new Promise<boolean>((resolve) => (out.resolveAccept = resolve));
    out.acceptTimeoutId = window.setTimeout(() => {
      if (out.accepted === null) {
        out.accepted = false;
        out.resolveAccept(false);
      }
    }, ACCEPT_TIMEOUT_MS);
    outgoing.set(fileId, out);

    const accepted = await out.acceptPromise;

    if (!accepted) {
      sendControl({ type: "CANCEL", fileId, reason: "not_accepted" });
      outgoing.delete(fileId);
      status(fileId, "cancelled", "Not accepted");
      log(`No accept for ${file.name} (timed out, declined, or cancelled)`);
      return;
    }

    if (out.cancelled) {
      outgoing.delete(fileId);
      status(fileId, "cancelled", "Cancelled before sending");
      return;
    }

    out.phase = "sending";
    let offset = 0;
    let index = 0;
    while (offset < file.size) {
      if (out.cancelled) {
        sendControl({ type: "CANCEL", fileId, reason: "cancelled_by_sender" });
        outgoing.delete(fileId);
        status(fileId, "cancelled", "Cancelled by sender");
        return;
      }
      const slice = file.slice(offset, offset + offer.chunkSize);
      const buf = await slice.arrayBuffer();
      await waitForBackpressure();
      opts.dataChannel.send(packFileChunk(fileId, index, buf));
      offset += buf.byteLength;
      index += 1;
      emit({ type: "progress", fileId, sentBytes: offset, totalBytes: file.size });
    }

    sendControl({ type: "DONE", fileId });
    emit({ type: "done", fileId });
    status(fileId, "done", "Sender finished");
    log(`Done sending ${file.name}`);
    outgoing.delete(fileId);
  }

  function acceptOffer(fileId: FileId) {
    const state = incoming.get(fileId);
    if (!state) return;
    state.accepted = true;
    state.phase = "receiving";
    sendControl({ type: "ACCEPT", fileId });
    status(fileId, "receiving", "Accepted and receiving");
    log(`Accepted ${state.offer.name}`);
    incomingOffer = null;
  }

  function declineOffer(fileId: FileId) {
    incoming.delete(fileId);
    incomingOffer = null;
    sendControl({ type: "DECLINE", fileId });
    status(fileId, "cancelled", "Declined by receiver");
    log(`Declined ${fileId}`);
  }

  function cancelTransfer(fileId: FileId) {
    const out = outgoing.get(fileId);
    if (out) {
      out.cancelled = true;
      if (out.accepted === null) out.resolveAccept(false);
      sendControl({ type: "CANCEL", fileId, reason: "cancelled_by_sender" });
      outgoing.delete(fileId);
      status(fileId, "cancelled", "Cancelled by sender");
      return;
    }
    if (incoming.has(fileId)) {
      incoming.delete(fileId);
      if (incomingOffer?.fileId === fileId) incomingOffer = null;
      sendControl({ type: "CANCEL", fileId, reason: "cancelled_by_receiver" });
      status(fileId, "cancelled", "Cancelled by receiver");
    }
  }

  return {
    get incomingOffer() {
      return incomingOffer;
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    sendFile,
    acceptOffer,
    declineOffer,
    cancelTransfer,
    dispose() {
      listeners.clear();
      incoming.clear();
      for (const [fileId, out] of outgoing) {
        if (out.accepted === null) out.resolveAccept(false);
        sendControl({ type: "CANCEL", fileId, reason: "session_disposed" });
      }
      outgoing.clear();
      incomingOffer = null;
    }
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

async function trySaveToDownloads(
  name: string,
  bytes: Uint8Array
): Promise<{ path: string } | null> {
  // Tauri v2 provides invoke via @tauri-apps/api/core.
  try {
    const mod = await import("@tauri-apps/api/core");
    const res = await mod.invoke<{ path: string }>("save_to_downloads", {
      name,
      bytes: Array.from(bytes)
    });
    return res;
  } catch {
    return null;
  }
}
