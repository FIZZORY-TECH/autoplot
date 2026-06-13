// Tauri v2 only injects `__TAURI_INTERNALS__`; v1 also exposed `__TAURI__`.
// Both markers count so design previews running under v1 still work.
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return w.__TAURI__ !== undefined || w.__TAURI_INTERNALS__ !== undefined;
}
