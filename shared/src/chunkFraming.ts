import type { FileId } from "./protocol.js";

const UUID_ASCII_LEN = 36;

export function packFileChunk(fileId: FileId, chunkIndex: number, payload: ArrayBuffer): ArrayBuffer {
  const headerLen = UUID_ASCII_LEN + 4 + 4;
  const buf = new ArrayBuffer(headerLen + payload.byteLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const idBytes = new TextEncoder().encode(fileId);
  if (idBytes.byteLength !== UUID_ASCII_LEN) throw new Error("fileId must be a UUID string");
  bytes.set(idBytes, 0);

  view.setUint32(UUID_ASCII_LEN, chunkIndex, true);
  view.setUint32(UUID_ASCII_LEN + 4, payload.byteLength, true);
  bytes.set(new Uint8Array(payload), headerLen);
  return buf;
}

export function unpackFileChunk(buf: ArrayBuffer): {
  fileId: FileId;
  chunkIndex: number;
  payload: ArrayBuffer;
} {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength < UUID_ASCII_LEN + 8) throw new Error("chunk too small");

  const fileId = new TextDecoder().decode(bytes.slice(0, UUID_ASCII_LEN)) as FileId;
  const chunkIndex = view.getUint32(UUID_ASCII_LEN, true);
  const payloadLen = view.getUint32(UUID_ASCII_LEN + 4, true);
  const headerLen = UUID_ASCII_LEN + 8;

  const payloadStart = headerLen;
  const payloadEnd = payloadStart + payloadLen;
  if (payloadEnd > bytes.byteLength) throw new Error("invalid payload length");

  const payload = bytes.slice(payloadStart, payloadEnd).buffer;
  return { fileId, chunkIndex, payload };
}

