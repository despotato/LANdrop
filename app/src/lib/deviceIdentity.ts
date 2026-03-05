import { storageKey } from "./storage.js";

export type LocalIdentity = {
  deviceId: string;
  name: string;
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

export async function getOrCreateIdentity(): Promise<LocalIdentity> {
  const deviceId = localStorage.getItem(storageKey("deviceId")) ?? crypto.randomUUID();
  localStorage.setItem(storageKey("deviceId"), deviceId);

  const name = localStorage.getItem(storageKey("deviceName")) ?? defaultName();
  localStorage.setItem(storageKey("deviceName"), name);

  const publicKeyJwk = await ensureKeypair();
  return { deviceId, name, publicKeyJwk };
}

export function setDeviceName(name: string) {
  localStorage.setItem(storageKey("deviceName"), name);
}
