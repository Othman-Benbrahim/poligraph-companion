/**
 * Cache local IndexedDB + stratégie de fallback à 3 niveaux :
 *
 *   Niveau 1 : API JSON en direct (fraîcheur) — géré par les appelants.
 *   Niveau 2 : cache IndexedDB, rafraîchi périodiquement depuis les
 *              exports CSV (refreshCache, déclenché par une alarme).
 *   Niveau 3 : snapshot embarqué dans l'extension (data/snapshot-*.json),
 *              chargé si le cache est vide à la première utilisation.
 *
 * La recherche de politiciens se fait TOUJOURS en local (l'index complet
 * tient en mémoire) : instantané, hors ligne, et zéro charge serveur.
 */

import { parseCSV } from "./csv.js";
import * as api from "./api.js";

const DB_NAME = "poligraph-cache";
const DB_VERSION = 7;
const STORES = ["politiques", "affaires", "factchecks", "maires", "hatvp", "meta"];

/* Clés primaires par store. Les fact-checks sont dénormalisés dans
   l'export (une ligne par paire politique × fact-check) : clé composite.
   Les maires (RNE) : clé commune INSEE + nom + prénom.
   HATVP : une ligne par document publié, clé composite. */
const KEY_PATHS = { politiques: "poligraphId", affaires: "poligraphId", factchecks: "_key", maires: "_key", hatvp: "_key", meta: "key" };

/* ---------------------- ouverture de la base ---------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Migration simple : on repart de zéro (les données se re-téléchargent).
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      for (const name of STORES) db.createObjectStore(name, { keyPath: KEY_PATHS[name] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

async function putAll(store, rows) {
  const db = await openDB();
  const keyPath = KEY_PATHS[store];
  return tx(db, store, "readwrite", (s) => {
    for (const row of rows) if (row[keyPath]) s.put(row);
  });
}

/* ---------------- normalisation des exports CSV ------------------- */
/* Les en-têtes des exports Poligraph sont des libellés FRANÇAIS
   (« Nom complet », « Parti (abrégé) »…), vérifiés dans le code source
   des routes /api/export/* (repo ironlam/poligraph). On normalise ici
   vers des clés camelCase stables : l'UI ne voit jamais les libellés. */

function normalizePolitique(r) {
  return {
    poligraphId: r["poligraphId"],
    slug: r["Slug"],
    civility: r["Civilité"],
    fullName: r["Nom complet"] || [r["Prénom"], r["Nom"]].filter(Boolean).join(" "),
    gender: r["Genre"],
    birthDate: r["Date de naissance"],
    birthPlace: r["Lieu de naissance"],
    deathDate: r["Date de décès"],
    party: r["Parti (abrégé)"] || r["Parti"],
    partyFull: r["Parti"],
    position: r["Position politique"],
    mandate: r["Mandat actuel"],
    mandateTitle: r["Titre du mandat"],
    mandateStart: r["Début du mandat"],
    constituency: r["Circonscription"],
    department: r["Code département"],
    affairsCount: Number(r["Nombre d'affaires"] || 0),
    factchecksCount: Number(r["Fact-checks (mentions)"] || 0),
    wikidataId: r["Wikidata Q-ID"],
    photo: r["Photo"],
    profileUrl: r["Profil Poligraph"],
  };
}

function normalizeAffaire(r) {
  return {
    poligraphId: r["poligraphId"],
    politicianPoligraphId: r["poligraphId politique"],
    title: r["Titre"],
    status: r["Statut"],
    statusCode: r["Statut (code)"],
    category: r["Catégorie"],
    categoryCode: r["Catégorie (code)"],
    severity: r["Gravité"],
    severityCode: r["Gravité (code)"],
    involvement: r["Implication"],
    involvementCode: r["Implication (code)"],
    partyAtTime: r["Parti au moment (abrégé)"] || r["Parti au moment"],
    currentParty: r["Parti actuel (abrégé)"] || r["Parti actuel"],
    factsDate: r["Date des faits"],
    verdictDate: r["Date du verdict"],
    sourceCount: Number(r["Nombre de sources"] || 0),
    sourceUrl: r["Première source (URL)"],
    pageUrl: r["Page Poligraph"],
  };
}

function normalizeFactcheck(r) {
  return {
    _key: `${r["poligraphId"]}|${r["poligraphId politique"]}`,
    poligraphId: r["poligraphId"],
    politicianPoligraphId: r["poligraphId politique"],
    title: r["Déclaration vérifiée"] || r["Titre"],
    verdict: r["Verdict (normalisé)"] || r["Verdict (texte)"],
    verdictCode: r["Verdict (code)"],
    factChecker: r["Fact-checker"],
    authorDirect: /^(oui|true|1|yes)$/i.test(r["Auteur direct"] ?? ""),
    detectedName: r["Nom détecté"],
    claimAuthor: r["Auteur de la déclaration"],
    url: r["URL source"],
    date: r["Date de publication"],
    pageUrl: r["Page Poligraph"],
  };
}

async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = t.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function setMeta(key, value) {
  const db = await openDB();
  return tx(db, "meta", "readwrite", (s) => s.put({ key, value }));
}

export async function getMeta(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const req = db.transaction("meta", "readonly").objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => resolve(null);
  });
}

/* ---------------------- rafraîchissement -------------------------- */

/**
 * Niveau 2 : télécharge les exports CSV et remplit IndexedDB.
 * Appelé par l'alarme quotidienne du background, et manuellement
 * depuis le popup ("Actualiser les données").
 * Lève ApiUnavailableError si Poligraph est injoignable.
 */
export async function refreshCache() {
  const [politiquesCSV, affairesCSV, factchecksCSV] = await Promise.all([
    api.fetchPolitiquesCSV(),
    api.fetchAffairesCSV(),
    api.fetchFactchecksCSV(),
  ]);

  await putAll("politiques", parseCSV(politiquesCSV).map(normalizePolitique));
  await putAll("affaires", parseCSV(affairesCSV).map(normalizeAffaire));
  await putAll("factchecks", parseCSV(factchecksCSV).map(normalizeFactcheck));
  await setMeta("lastRefresh", Date.now());
}

/**
 * Niveau 3 : si le cache est vide (première installation hors ligne),
 * charge le snapshot embarqué au build. Fichiers optionnels.
 */
export async function seedFromSnapshotIfEmpty() {
  const existing = await getAll("politiques");
  if (existing.length > 0) return false;
  try {
    const url = browser.runtime.getURL("data/snapshot-politiques.json");
    const rows = await (await fetch(url)).json();
    if (Array.isArray(rows) && rows.length) {
      // Le snapshot est généré depuis le CSV brut : normaliser aussi.
      const normalized = rows[0]?.fullName ? rows : rows.map(normalizePolitique);
      await putAll("politiques", normalized);
      await setMeta("lastRefresh", 0); // 0 = données du snapshot, âge inconnu
      return true;
    }
  } catch {
    /* snapshot absent : ignorer */
  }
  return false;
}

/* ---------------------- lecture / recherche ----------------------- */

/** Normalise pour la recherche : minuscules, sans accents. */
function fold(s) {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Nom d'affichage (données normalisées à l'ingestion). */
function displayName(row) {
  return row.fullName || row.slug || row.poligraphId;
}

/**
 * Recherche locale de politiciens par nom (sous-chaîne, insensible
 * aux accents et à la casse). Retourne au plus `max` résultats.
 */
export async function searchPolitiques(query, max = 12) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const all = await getAll("politiques");
  const scored = [];
  for (const row of all) {
    const name = fold(displayName(row));
    const idx = name.indexOf(q);
    if (idx !== -1) scored.push({ row, score: idx === 0 ? 0 : idx });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((s) => ({ ...s.row, _displayName: displayName(s.row) }));
}

/** Affaires d'un politicien, jointure locale sur politicianPoligraphId. */
export async function affairesFor(politicianPoligraphId) {
  const all = await getAll("affaires");
  return all.filter((a) => a.politicianPoligraphId === politicianPoligraphId);
}

/** Fact-checks mentionnant un politicien (une ligne par paire dans l'export). */
export async function factchecksFor(politicianPoligraphId) {
  const all = await getAll("factchecks");
  return all.filter((f) => f.politicianPoligraphId === politicianPoligraphId);
}

/* ------------------- cache opportuniste des votes ------------------ */
/* Les votes individuels ne sont pas dans les exports CSV : ils sont
   récupérés à la demande via l'API JSON (niveau 1), et la dernière
   réponse est conservée ici pour le mode hors ligne (niveau 2). */

export async function setCachedVotes(slug, payload) {
  await setMeta(`votes:${slug}`, { ts: Date.now(), payload });
}

export async function getCachedVotes(slug) {
  return getMeta(`votes:${slug}`); // { ts, payload } | null
}

/* --------------- enrichissement Wikidata (partis, contacts) -------- */

/**
 * Complète parti (P102), site officiel (P856) et courriel (P968) des
 * politiciens dotés d'un Q-ID Wikidata. Champs de provenance distincts
 * (wikidataParty, wikidataWebsite, wikidataEmail — jamais fusionnés).
 * Marqueur wdEnriched pour ne traiter chaque profil qu'une fois.
 * Plafonné ; les exécutions suivantes reprennent où ça s'est arrêté.
 */
export async function enrichPartiesFromWikidata(maxEntities = 500) {
  const { resolveParties } = await import("./wikidata.js");
  const all = await getAll("politiques");

  const candidates = all.filter((p) => p.wikidataId && !p.wdEnriched);
  const slice = candidates.slice(0, maxEntities);
  if (slice.length === 0) return { enriched: 0, remaining: 0 };

  const infos = await resolveParties(slice.map((p) => p.wikidataId));

  let enriched = 0;
  const updated = slice.map((p) => {
    const hit = infos.get(p.wikidataId);
    if (hit) enriched++;
    return {
      ...p,
      wdEnriched: true,
      wikidataParty: hit?.partyLabel ?? null,
      wikidataPartyQid: hit?.partyQid ?? null,
      wikidataWebsite: hit?.website ?? null,
      wikidataEmail: hit?.email ?? null,
    };
  });
  await putAll("politiques", updated);

  return { enriched, remaining: candidates.length - slice.length };
}

/* ----------------------- maires (RNE) ------------------------------ */

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Télécharge le RNE maires si le cache a plus d'une semaine. */
export async function refreshRNEIfStale() {
  const last = await getMeta("lastRNERefresh");
  if (last && Date.now() - last < WEEK_MS) return { refreshed: false };
  const { fetchMairesRNE } = await import("./rne.js");
  const maires = await fetchMairesRNE();
  if (maires.length === 0) throw new Error("RNE : fichier vide ou format inattendu");
  await putAll("maires", maires);
  await setMeta("lastRNERefresh", Date.now());
  return { refreshed: true, count: maires.length };
}

/** Recherche de maires par nom OU par commune (le réflexe citoyen :
 *  « qui est le maire de X ? » → taper le nom de la commune marche). */
export async function searchMaires(query, max = 8) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const all = await getAll("maires");
  const scored = [];
  for (const m of all) {
    const name = fold(m.fullName);
    const commune = fold(m.commune);
    const nameIdx = name.indexOf(q);
    const communeIdx = commune.indexOf(q);
    if (nameIdx === -1 && communeIdx === -1) continue;
    // Nom exact d'abord, puis commune commençant par la requête.
    const score = nameIdx === 0 ? 0 : communeIdx === 0 ? 1 : 2 + Math.min(
      nameIdx === -1 ? 99 : nameIdx, communeIdx === -1 ? 99 : communeIdx);
    scored.push({ m, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((s) => ({ ...s.m, _displayName: s.m.fullName }));
}

/* -------------------- contacts parlementaires ---------------------- */

/** Rafraîchit l'index NosDéputés/NosSénateurs si obsolète ou d'ancienne version. */
const PARLEMENT_INDEX_VERSION = 3; // v3 : Datan pour les députés (NosDéputés figé depuis 2024)

export async function refreshParlementIfStale() {
  const last = await getMeta("lastParlementRefresh");
  const version = await getMeta("parlementIndexVersion");
  if (last && Date.now() - last < WEEK_MS && version === PARLEMENT_INDEX_VERSION) {
    return { refreshed: false };
  }
  const { fetchParlementIndex } = await import("./parlement.js");
  const index = await fetchParlementIndex();
  if (Object.keys(index).length === 0) throw new Error("Parlement : index vide");
  await setMeta("parlement:index", index);
  await setMeta("lastParlementRefresh", Date.now());
  await setMeta("parlementIndexVersion", PARLEMENT_INDEX_VERSION);
  return { refreshed: true, count: Object.keys(index).length };
}

/** Contact parlementaire d'un politicien, par nom complet. */
export async function parlementContactFor(fullName) {
  const index = await getMeta("parlement:index");
  if (!index) return null;
  const { lookupParlement } = await import("./parlement.js");
  return lookupParlement(index, fullName);
}

/** Diagnostic : volumétrie des stores et fraîcheur des sources. */
export async function storeDiagnostics() {
  const db = await openDB();
  const count = (store) => new Promise((resolve) => {
    const req = db.transaction(store, "readonly").objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(-1);
  });
  return {
    politiques: await count("politiques"),
    maires: await count("maires"),
    lastRefresh: await getMeta("lastRefresh"),
    lastRNERefresh: await getMeta("lastRNERefresh"),
    lastParlementRefresh: await getMeta("lastParlementRefresh"),
  };
}

/* -------------------- transparence (HATVP) ------------------------- */

/** Télécharge l'index HATVP si le cache a plus d'une semaine. */
export async function refreshHatvpIfStale() {
  const last = await getMeta("lastHatvpRefresh");
  if (last && Date.now() - last < WEEK_MS) return { refreshed: false };
  const { fetchHatvpIndex } = await import("./hatvp.js");
  const rows = await fetchHatvpIndex();
  if (rows.length === 0) throw new Error("HATVP : liste vide ou format inattendu");
  await putAll("hatvp", rows);
  await setMeta("lastHatvpRefresh", Date.now());
  return { refreshed: true, count: rows.length };
}

/** Déclarations HATVP d'une personne (appariement par nom plié),
 *  triées de la plus récente à la plus ancienne. */
export async function hatvpFor(fullName) {
  const target = fold(fullName);
  const all = await getAll("hatvp");
  return all
    .filter((r) => r.foldedName === target)
    .sort((a, b) => (b.dateDepot || b.datePublication || "").localeCompare(a.dateDepot || a.datePublication || ""));
}

/* -------------- délibérations & actes (catalogue) ------------------ */

/** Jeux de données « délibérations » d'une commune — cache 7 jours. */
export async function deliberationsFor(codeInsee, communeName) {
  const cached = await getMeta(`delib2:${codeInsee}`);
  if (cached && Date.now() - cached.ts < WEEK_MS) return cached.items;
  const { searchDeliberations } = await import("./catalogue.js");
  const items = await searchDeliberations(communeName, codeInsee);
  await setMeta(`delib2:${codeInsee}`, { ts: Date.now(), items });
  return items;
}

/* -------------------- biographie Wikipédia ------------------------- */

const MONTH_MS = 30 * 24 * 3600 * 1000;

/** Résumé Wikipédia par Q-ID — cache 30 jours, échecs 24 h. */
export async function bioFor(qid) {
  const cached = await getMeta(`bio:${qid}`);
  if (cached) {
    if (cached.bio && Date.now() - cached.ts < MONTH_MS) return cached.bio;
    if (!cached.bio && Date.now() - cached.ts < DAY_MS) return null;
  }
  const { getBioForQid } = await import("./wikipedia.js");
  const bio = await getBioForQid(qid); // peut lever si hors ligne
  await setMeta(`bio:${qid}`, { ts: Date.now(), bio });
  return bio;
}

/* -------------------- contacts mairies (DILA) ---------------------- */

const DAY_MS = 24 * 3600 * 1000;

/**
 * Contact de la mairie, avec cache local par code INSEE.
 * Les succès sont conservés ; les échecs ne sont mémorisés que 24 h
 * (une mairie non trouvée aujourd'hui peut l'être demain).
 */
export async function mairieContactFor(codeInsee, communeName) {
  const cached = await getMeta(`mairie2:${codeInsee}`);
  if (cached) {
    if (cached.contact) return cached.contact;
    if (Date.now() - cached.ts < DAY_MS) return null; // échec récent : ne pas re-tenter
  }
  const { getMairieContact } = await import("./annuaire.js");
  const contact = await getMairieContact(codeInsee, communeName); // peut lever si hors ligne
  await setMeta(`mairie2:${codeInsee}`, { ts: Date.now(), contact });
  return contact;
}
