import type { DeviceType } from "@landrop/shared";
import { storageKey } from "./storage.js";

export type LocalIdentity = {
  deviceId: string;
  name: string;
  deviceType: DeviceType;
  publicKeyJwk: JsonWebKey;
};

function defaultName(): string {
  return `Device ${Math.floor(Math.random() * 1000)}`;
}

async function ensureKeypair(): Promise<JsonWebKey> {
  const existing = localStorage.getItem(storageKey("publicKeyJwk"));
  if (existing) return JSON.parse(existing) as JsonWebKey;

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  localStorage.setItem(storageKey("publicKeyJwk"), JSON.stringify(jwk));
  return jwk;
}

function detectDeviceType(): DeviceType {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) return "ios";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  if (ua.includes("linux")) return "linux";
  if (ua.includes("tauri") || ua.includes("mozilla")) return "web";
  return "unknown";
}

export async function getOrCreateIdentity(): Promise<LocalIdentity> {
  const deviceId = localStorage.getItem(storageKey("deviceId")) ?? crypto.randomUUID();
  localStorage.setItem(storageKey("deviceId"), deviceId);

  const name = localStorage.getItem(storageKey("deviceName")) ?? defaultName();
  localStorage.setItem(storageKey("deviceName"), name);

  const deviceType = detectDeviceType();
  const publicKeyJwk = await ensureKeypair();
  return { deviceId, name, deviceType, publicKeyJwk };
}

export function setDeviceName(name: string) {
  localStorage.setItem(storageKey("deviceName"), name);
}
