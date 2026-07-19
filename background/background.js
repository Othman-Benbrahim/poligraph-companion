/**
 * Background (event page Firefox / service worker Chrome).
 * Rôles : alarme de rafraîchissement du cache, menu contextuel
 * "Chercher sur Poligraph" sur sélection de texte.
 *
 * IMPORTANT (portage Chrome) : un service worker peut être tué à tout
 * moment — aucun état en variable globale, tout passe par storage/IndexedDB.
 */

import "../lib/browser-shim.js";
import {
  refreshCache, seedFromSnapshotIfEmpty, getMeta, enrichPartiesFromWikidata,
  refreshRNEIfStale, refreshParlementIfStale, refreshHatvpIfStale,
  buildNameIndex, checkFeedsForFollows, unreadSuiviCount,
} from "../lib/cache.js";

const REFRESH_ALARM = "poligraph-refresh";
const REFRESH_PERIOD_MIN = 24 * 60; // 24 h
const RSS_ALARM = "poligraph-rss";
const RSS_PERIOD_MIN = 6 * 60; // 6 h

/* ------------------- identification du trafic ---------------------- */
/*
 * À la demande du créateur de Poligraph : les requêtes de l'extension
 * vers poligraph.fr s'identifient par un User-Agent dédié, pour qu'il
 * repère ce trafic dans ses logs (suivi, limites, entraide).
 *
 * fetch() ne peut pas modifier User-Agent (en-tête protégé) : on passe
 * par declarativeNetRequest. Règle de SESSION (réinstallée à chaque
 * réveil du background), strictement bornée :
 *   - poligraph.fr uniquement (Wikidata, data.gouv, etc. gardent l'UA
 *     normal du navigateur) ;
 *   - tabIds: [-1] = requêtes hors onglet (background + popup), donc
 *     JAMAIS la navigation de l'utilisateur sur le site poligraph.fr.
 * Aucune donnée utilisateur : juste le nom et la version de l'extension.
 */
const UA_RULE_ID = 1;

async function installUserAgentRule() {
  try {
    const version = browser.runtime.getManifest().version;
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [UA_RULE_ID],
      addRules: [{
        id: UA_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{
            header: "User-Agent",
            operation: "set",
            value: `PoligraphCompanion/${version}`,
          }],
        },
        condition: {
          urlFilter: "||poligraph.fr/",
          tabIds: [-1],
          resourceTypes: ["xmlhttprequest"],
        },
      }],
    });
    console.info(`[Poligraph] User-Agent identifiant actif : PoligraphCompanion/${version}`);
  } catch (err) {
    // DNR ou tabIds non supportés : on n'installe RIEN plutôt que de
    // risquer de marquer la navigation de l'utilisateur sur le site.
    console.warn(`[Poligraph] User-Agent identifiant non installé (${err.message})`);
  }
}

// À chaque chargement du background (réveil du service worker inclus).
installUserAgentRule();

/* ------------------------- installation --------------------------- */

browser.runtime.onInstalled.addListener(async () => {
  browser.contextMenus.create({
    id: "poligraph-search-selection",
    title: 'Chercher "%s" sur Poligraph',
    contexts: ["selection"],
  });

  browser.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MIN });
  browser.alarms.create(RSS_ALARM, { periodInMinutes: RSS_PERIOD_MIN });

  // Premier remplissage : snapshot embarqué puis tentative réseau.
  await seedFromSnapshotIfEmpty();
  tryRefresh();
});

/* ------------------------- rafraîchissement ----------------------- */

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) tryRefresh();
  if (alarm.name === RSS_ALARM) checkRss();
});

/* --------------------------- suivi RSS ----------------------------- */

async function updateBadge() {
  const n = await unreadSuiviCount();
  await browser.action.setBadgeText({ text: n > 0 ? String(n) : "" });
  await browser.action.setBadgeBackgroundColor({ color: "#2f4b8f" });
}

async function checkRss() {
  try {
    const added = await checkFeedsForFollows();
    if (added) console.info(`[Poligraph] suivi RSS : ${added} nouvel(s) élément(s)`);
    await updateBadge();
  } catch (err) {
    console.warn(`[Poligraph] suivi RSS impossible (${err.message})`);
  }
}

async function tryRefresh() {
  const report = {};

  try {
    await refreshCache();
    report.poligraph = "✓";
    console.info("[Poligraph] cache rafraîchi");
  } catch (err) {
    const last = await getMeta("lastRefresh");
    report.poligraph = `✗ ${err.message.slice(0, 60)}`;
    console.warn(`[Poligraph] rafraîchissement impossible (${err.message}). ` +
      `Dernières données : ${last ? new Date(last).toLocaleString("fr-FR") : "snapshot embarqué"}`);
  }

  // Enrichissement Wikidata des partis manquants — indépendant de Poligraph,
  // tenté même si le refresh a échoué (le cache peut avoir des trous à combler).
  try {
    const { enriched, remaining } = await enrichPartiesFromWikidata();
    report.wikidata = `✓${remaining ? ` (${remaining} restants)` : ""}`;
    if (enriched || remaining) {
      console.info(`[Poligraph] Wikidata : ${enriched} profils enrichis, ${remaining} restants`);
    }
  } catch (err) {
    report.wikidata = `✗ ${err.message.slice(0, 60)}`;
    console.warn(`[Poligraph] enrichissement Wikidata impossible (${err.message})`);
  }

  // Sources hebdomadaires — chacune échoue sans bloquer les autres,
  // avec vérification préalable de la permission d'hôte (Firefox MV3
  // ne les accorde pas automatiquement).
  report.rne = await tryWeekly(
    ["https://*.data.gouv.fr/*"],
    refreshRNEIfStale, "RNE", (r) => r.refreshed ? `✓ ${r.count} maires` : "✓ à jour");
  report.parlement = await tryWeekly(
    ["https://www.data.gouv.fr/*"],
    refreshParlementIfStale, "Parlement", (r) => r.refreshed ? `✓ ${r.count} contacts` : "✓ à jour");
  report.hatvp = await tryWeekly(
    ["https://www.hatvp.fr/*"],
    refreshHatvpIfStale, "HATVP", (r) => r.refreshed ? `✓ ${r.count} déclarations` : "✓ à jour");

  return report;
}

async function tryWeekly(origins, fn, label, fmt) {
  try {
    const granted = await browser.permissions.contains({ origins }).catch(() => true);
    if (!granted) {
      console.warn(`[Poligraph] ${label} : permission d'hôte non accordée (${origins.join(", ")})`);
      return "✗ permission refusée — about:addons → Permissions";
    }
    const result = await fn();
    console.info(`[Poligraph] ${label} :`, result);
    return fmt(result);
  } catch (err) {
    console.warn(`[Poligraph] ${label} indisponible (${err.message})`);
    return `✗ ${err.message.slice(0, 60)}`;
  }
}

/* ------------------------- menu contextuel ------------------------ */

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "poligraph-search-selection" || !info.selectionText) return;

  // Transmettre la sélection au popup via storage.session
  // (survit à la mort du service worker, meurt avec le navigateur).
  await browser.storage.session.set({ pendingQuery: info.selectionText.trim() });

  // Firefox et Chrome ≥127 supportent action.openPopup depuis un geste
  // utilisateur. Fallback : ouvrir la recherche Poligraph dans un onglet.
  try {
    await browser.action.openPopup();
  } catch {
    const q = encodeURIComponent(info.selectionText.trim());
    await browser.tabs.create({ url: `https://poligraph.fr/recherche?q=${q}` });
  }
});

/* ------------------------- messages du popup ---------------------- */

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "refresh-now") {
    return tryRefresh().then((report) => ({ ok: true, report }))
      .catch((e) => ({ ok: false, error: e.message }));
  }
  if (msg?.type === "get-name-index") {
    // Index compact pour le content script (détection sur les pages).
    // Mis en cache en storage.session : reconstruit au plus une fois
    // par session de navigateur, survit à la mort du service worker.
    return browser.storage.session.get("nameIndex").then(async ({ nameIndex }) => {
      if (nameIndex) return { index: nameIndex };
      const index = await buildNameIndex();
      await browser.storage.session.set({ nameIndex: index }).catch(() => {});
      return { index };
    });
  }
  if (msg?.type === "check-rss-now") {
    return checkRss().then(() => ({ ok: true }));
  }
  if (msg?.type === "badge-refresh") {
    return updateBadge().then(() => ({ ok: true }));
  }
});
