/**
 * Client API Poligraph.
 *
 * Conçu comme un module de fonctions typées et autonomes :
 * en v2, chacune deviendra un "tool" exposé au LLM de l'assistant
 * (pattern function calling). Ne rien coupler à l'UI ici.
 *
 * Endpoints documentés (https://poligraph.fr/docs/api) :
 *   - GET /api/affaires            JSON paginé (20/page, max 100)
 *   - GET /api/export/politiques   CSV complet (index des politiques)
 *   - GET /api/export/affaires     CSV complet (limit max 50 000)
 *   - GET /api/export/factchecks   CSV complet
 *   - Flux RSS : /api/rss/{affaires,votes,factchecks}.xml
 *
 * NOTE : d'autres routes JSON existent (voir l'explorateur Swagger
 * sur /docs/api). Les valider avant de les ajouter ici — ne pas deviner.
 */

const BASE = "https://poligraph.fr";
const TIMEOUT_MS = 20_000;

/** fetch avec timeout — lève ApiUnavailableError si réseau/serveur KO. */
async function request(path, { accept = "application/json" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: accept },
    });
    if (!res.ok) throw new ApiUnavailableError(`HTTP ${res.status} sur ${path}`);
    return res;
  } catch (err) {
    if (err instanceof ApiUnavailableError) throw err;
    throw new ApiUnavailableError(`Réseau indisponible (${err.name}) sur ${path}`);
  } finally {
    clearTimeout(timer);
  }
}

export class ApiUnavailableError extends Error {
  constructor(msg) { super(msg); this.name = "ApiUnavailableError"; }
}

/* ------------------------------------------------------------------ */
/* Exports CSV — alimentent le cache IndexedDB (fallback niveau 2)     */
/* ------------------------------------------------------------------ */

/** Télécharge l'index complet des politiques (CSV → texte brut). */
export async function fetchPolitiquesCSV() {
  const res = await request("/api/export/politiques", { accept: "text/csv" });
  return res.text();
}

/** Télécharge l'export complet des affaires (CSV → texte brut). */
export async function fetchAffairesCSV(limit = 10_000) {
  const res = await request(`/api/export/affaires?limit=${limit}`, { accept: "text/csv" });
  return res.text();
}

/** Télécharge l'export complet des fact-checks (CSV → texte brut). */
export async function fetchFactchecksCSV(limit = 10_000) {
  const res = await request(`/api/export/factchecks?limit=${limit}`, { accept: "text/csv" });
  return res.text();
}

/* ------------------------------------------------------------------ */
/* API JSON — couche "fraîcheur" (fallback niveau 1)                   */
/* ------------------------------------------------------------------ */

/**
 * Liste paginée des affaires (données les plus fraîches).
 * @param {object} opts  { page, limit, involvement }
 */
export async function fetchAffairesJSON({ page = 1, limit = 100, involvement = "DIRECT" } = {}) {
  const params = new URLSearchParams({ page, limit, involvement });
  const res = await request(`/api/affaires?${params}`);
  return res.json(); // { data: [...], pagination: {...} }
}

/**
 * Votes parlementaires d'un représentant (scrutins récents d'abord).
 * Route vérifiée dans le code source : /api/politiques/{slug}/votes
 * Retour : { politician, stats: { total, pour, contre, abstention,
 *            nonVotant, absent, participationRate }, votes: [{ position,
 *            scrutin: { title, votingDate, legislature, result, sourceUrl } }],
 *            pagination }
 */
export async function fetchVotesJSON(slug, { page = 1, limit = 30 } = {}) {
  const params = new URLSearchParams({ page, limit });
  const res = await request(`/api/politiques/${encodeURIComponent(slug)}/votes?${params}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Utilitaires de citation                                             */
/* ------------------------------------------------------------------ */

/** URL canonique stable d'une entité (redirect 308 garanti par Poligraph). */
export function canonicalUrl(poligraphId) {
  return `${BASE}/id/${encodeURIComponent(poligraphId)}`;
}
