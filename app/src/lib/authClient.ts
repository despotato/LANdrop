export type DeviceAuthStart = {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval?: number;
};

export type DeviceAuthPollOk = {
  ok: true;
  sessionToken: string;
  user: { sub: string; email?: string; name?: string; picture?: string };
  expiresAtMs: number;
};

export type DeviceAuthPollPending = { ok: false; pending: boolean; error: string };

function wsToHttpBase(url: string): string {
  if (url.startsWith("ws://")) return "http://" + url.slice("ws://".length);
  if (url.startsWith("wss://")) return "https://" + url.slice("wss://".length);
  return url;
}

export function getSignalingHttpBase(wsUrl: string): string {
  // WS is expected to be like ws(s)://host:port
  const base = wsToHttpBase(wsUrl);
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export async function localSignup(
  httpBase: string,
  email: string,
  password: string
): Promise<{ ok: true; sessionToken: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${httpBase}/auth/local/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = (await res.json()) as any;
    if (!data.ok) return { ok: false, error: String(data.error ?? "error") };
    return { ok: true, sessionToken: String(data.sessionToken) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function localLogin(
  httpBase: string,
  email: string,
  password: string
): Promise<{ ok: true; sessionToken: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${httpBase}/auth/local/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = (await res.json()) as any;
    if (!data.ok) return { ok: false, error: String(data.error ?? "error") };
    return { ok: true, sessionToken: String(data.sessionToken) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Portable LAN auth token: `local:<sha256(email:password)>`.
 *
 * This does not require server state, so any LAN signaling server can scope devices by the same token.
 */
export async function derivePortableLocalToken(email: string, password: string): Promise<string> {
  const normalized = `${normalizeEmail(email)}:${password}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return `local:${toHex(new Uint8Array(digest))}`;
}

export async function startGoogleDeviceAuth(httpBase: string): Promise<
  { ok: true; start: DeviceAuthStart } | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${httpBase}/auth/google/device/start`, { method: "POST" });
    const data = (await res.json()) as any;
    if (!data.ok) return { ok: false, error: String(data.error ?? "error") };
    return { ok: true, start: data as DeviceAuthStart };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function pollGoogleDeviceAuth(
  httpBase: string,
  deviceCode: string
): Promise<DeviceAuthPollOk | DeviceAuthPollPending> {
  const res = await fetch(`${httpBase}/auth/google/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode })
  });
  return (await res.json()) as any;
}
