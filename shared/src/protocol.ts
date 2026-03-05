export type DeviceId = string;
export type PairCode = string;
export type FileId = string;
export type DeviceType = "windows" | "macos" | "linux" | "android" | "ios" | "web" | "unknown";

export type IceCandidateInit = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type WsClientHello = {
  type: "hello";
  deviceId: DeviceId;
  name: string;
  deviceType?: DeviceType;
  publicKeyJwk: JsonWebKey;
  authToken?: string;
  findable?: boolean;
};

export type WsServerWelcome = {
  type: "welcome";
  serverTimeMs: number;
  authRequired: boolean;
  user?: { sub: string; email?: string; name?: string; picture?: string };
};

export type WsPresence = {
  type: "presence";
  devices: Array<{
    deviceId: DeviceId;
    name: string;
    deviceType?: DeviceType;
    scope?: "mine" | "other";
    online: boolean;
    lastSeenMs: number;
    findable: boolean;
    publicKeyJwk?: JsonWebKey;
  }>;
};

export type WsPairCreate = {
  type: "pair.create";
};

export type WsPairCreated = {
  type: "pair.created";
  code: PairCode;
  expiresAtMs: number;
};

export type WsPairJoin = {
  type: "pair.join";
  code: PairCode;
};

export type WsPairMatched = {
  type: "pair.matched";
  sessionId: string;
  peer: { deviceId: DeviceId; name: string; deviceType?: DeviceType; publicKeyJwk: JsonWebKey };
};

export type WsError = {
  type: "error";
  message: string;
};

export type WsShareRequest = {
  type: "share.request";
  to: DeviceId;
  requestId: string;
};

export type WsShareRequestForward = {
  type: "share.request";
  from: DeviceId;
  requestId: string;
  fromName: string;
  fromDeviceType?: DeviceType;
};

export type WsShareResponse = {
  type: "share.response";
  to: DeviceId;
  requestId: string;
  accepted: boolean;
};

export type WsShareResponseForward = {
  type: "share.response";
  from: DeviceId;
  requestId: string;
  accepted: boolean;
};

export type WsWebrtcOffer = {
  type: "webrtc.offer";
  to: DeviceId;
  sdp: string;
};

export type WsWebrtcAnswer = {
  type: "webrtc.answer";
  to: DeviceId;
  sdp: string;
};

export type WsWebrtcIce = {
  type: "webrtc.ice";
  to: DeviceId;
  candidate: IceCandidateInit;
};

export type WsClientMessage =
  | WsClientHello
  | WsPairCreate
  | WsPairJoin
  | WsShareRequest
  | WsShareResponse
  | WsWebrtcOffer
  | WsWebrtcAnswer
  | WsWebrtcIce;

export type WsServerMessage =
  | WsServerWelcome
  | WsPresence
  | WsPairCreated
  | WsPairMatched
  | WsError
  | WsShareRequestForward
  | WsShareResponseForward
  | (WsWebrtcOffer & { from: DeviceId })
  | (WsWebrtcAnswer & { from: DeviceId })
  | (WsWebrtcIce & { from: DeviceId });

export type DcHello = {
  type: "HELLO";
  deviceId: DeviceId;
  name: string;
};

export type DcFileOffer = {
  type: "FILE_OFFER";
  fileId: FileId;
  name: string;
  size: number;
  chunkSize: number;
  mimeType: string;
};

export type DcAccept = { type: "ACCEPT"; fileId: FileId };
export type DcDecline = { type: "DECLINE"; fileId: FileId };
export type DcCancel = { type: "CANCEL"; fileId: FileId; reason?: string };
export type DcChunkAck = { type: "CHUNK_ACK"; fileId: FileId; index: number };
export type DcDone = { type: "DONE"; fileId: FileId };

export type DcClipboard = {
  type: "CLIPBOARD_TEXT";
  text: string;
  nonce: string;
};

export type DcControlMessage =
  | DcHello
  | DcFileOffer
  | DcAccept
  | DcDecline
  | DcCancel
  | DcChunkAck
  | DcDone
  | DcClipboard;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
