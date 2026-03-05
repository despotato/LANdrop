export type EnsureResult = { ws_url: string; http_url: string; started: boolean; auth_required: boolean };

export async function ensureSignaling(): Promise<EnsureResult | null> {
  try {
    const core = await import("@tauri-apps/api/core");
    const res = await core.invoke<EnsureResult>("ensure_signaling", {
      timeoutMs: 800,
      discoveryPort: 8788,
      port: 8787
    });
    return res;
  } catch {
    return null;
  }
}
