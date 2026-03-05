export type DiscoveredServer = { ws_url: string; http_url: string; auth_required: boolean };

export async function discoverSignaling(): Promise<DiscoveredServer[] | null> {
  // Only available in Tauri.
  try {
    const core = await import("@tauri-apps/api/core");
    const res = await core.invoke<DiscoveredServer[]>("discover_signaling", {
      timeoutMs: 800,
      discoveryPort: 8788
    });
    return res;
  } catch {
    return null;
  }
}

