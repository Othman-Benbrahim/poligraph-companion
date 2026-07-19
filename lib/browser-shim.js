/**
 * Shim de compatibilité Firefox / Chrome.
 * Firefox expose `browser.*` (promesses natives).
 * Chrome MV3 expose `chrome.*` (promesses supportées depuis MV3).
 * Après import de ce module, utiliser `browser.*` partout.
 */
if (typeof globalThis.browser === "undefined") {
  globalThis.browser = globalThis.chrome;
}
export const browser = globalThis.browser;
