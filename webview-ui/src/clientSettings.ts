/**
 * Client-side settings persistence via localStorage.
 *
 * These settings control UI-only behavior (sound, labels, areas, changelog tracking)
 * and are stored per-browser rather than on the server. Remote clients can toggle
 * these independently without affecting other clients or the server.
 *
 * For remote clients on first load, when localStorage is empty, the server-provided
 * defaults are used and written to localStorage (migration path).
 */

const PREFIX = 'pixel-agents.';

export const CLIENT_SETTING_KEYS = {
  SOUND_ENABLED: PREFIX + 'soundEnabled',
  ALWAYS_SHOW_LABELS: PREFIX + 'alwaysShowLabels',
  SHOW_AREAS: PREFIX + 'showAreas',
  LAST_SEEN_VERSION: PREFIX + 'lastSeenVersion',
  HOOKS_INFO_SHOWN: PREFIX + 'hooksInfoShown',
} as const;

export type ClientSettingKey = (typeof CLIENT_SETTING_KEYS)[keyof typeof CLIENT_SETTING_KEYS];

/**
 * Write a client-side setting to localStorage.
 * Silently fails if localStorage is unavailable (private browsing, quota exceeded).
 */
export function setClientSetting<T>(key: ClientSettingKey, value: T): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or private browsing — silently ignore
  }
}

/**
 * Resolve a client-side setting value based on readOnly mode.
 *
 * - If !readOnly (localhost): return serverValue directly (no localStorage)
 * - If readOnly (remote): use localStorage if set, otherwise migrate serverValue to localStorage
 *
 * This helper encapsulates the branching logic for client-only settings that
 * should persist per-browser for remote clients but use server values for localhost.
 */
export function resolveClientSetting<T>(
  readOnly: boolean,
  key: ClientSettingKey,
  serverValue: T,
): T {
  if (!readOnly) {
    return serverValue;
  }
  // Remote client: single localStorage read, migrate if not set
  if (typeof window === 'undefined' || !window.localStorage) {
    return serverValue;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      window.localStorage.setItem(key, JSON.stringify(serverValue));
      return serverValue;
    }
    return JSON.parse(raw) as T;
  } catch {
    return serverValue;
  }
}
