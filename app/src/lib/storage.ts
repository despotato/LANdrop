function readProfileFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const p = url.searchParams.get("profile");
    return p && p.trim() ? p.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Storage namespace for simulating multiple devices in the same browser.
 *
 * - Default: `"default"` (stable, original behavior)
 * - Dev simulation: open app with `?profile=a` and `?profile=b` in two windows
 */
export function getProfileId(): string {
  return readProfileFromUrl() ?? "default";
}

export function storageKey(name: string): string {
  return `sendpipe:${getProfileId()}:${name}`;
}

