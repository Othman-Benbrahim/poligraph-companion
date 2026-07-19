/**
 * Popup — recherche instantanée (cache local) + fiche synthétique.
 * Aucune requête réseau au fil de la frappe : tout est servi par
 * IndexedDB, l'API n'est sollicitée que par le rafraîchissement.
 */

import "../lib/browser-shim.js";
import {
  searchPolitiques, affairesFor, factchecksFor,
  getMeta, seedFromSnapshotIfEmpty,
  setCachedVotes, getCachedVotes,
  searchMaires, mairieContactFor, parlementContactFor, storeDiagnostics, bioFor,
  deliberationsFor, hatvpFor, getFollows, toggleFollow, getSuiviItems, markSuiviRead,
} from "../lib/cache.js";
import { canonicalUrl, fetchVotesJSON } from "../lib/api.js";

const $ = (id) => document.getElementById(id);
const viewSearch = $("view-search");
const viewFiche = $("view-fiche");

/* ------------------- statuts judiciaires → timbres ------------------- */
/* Regroupement conservateur : la couleur encode l'état de la procédure,
   conformément aux règles éditoriales Poligraph (présomption d'innocence). */
const STATUS_GROUPS = {
  rouge: ["CONDAMNATION_DEFINITIVE"],
  ambre: [
    "ENQUETE_PRELIMINAIRE", "INSTRUCTION", "MISE_EN_EXAMEN",
    "RENVOI_TRIBUNAL", "PROCES_EN_COURS",
    "CONDAMNATION_PREMIERE_INSTANCE", "APPEL_EN_COURS",
  ],
  vert: ["RELAXE", "ACQUITTEMENT", "NON_LIEU"],
  gris: ["PRESCRIPTION", "CLASSEMENT_SANS_SUITE"],
};

function timbreClass(statusCode) {
  for (const [cls, codes] of Object.entries(STATUS_GROUPS)) {
    if (codes.includes(statusCode)) return cls;
  }
  return "gris";
}

/* --------------------------- âge des données ------------------------- */

async function renderDataAge() {
  const el = $("data-age");
  const last = await getMeta("lastRefresh");
  el.hidden = false;
  if (last === null) {
    el.textContent = "Aucune donnée locale — cliquez sur ⟳ pour télécharger.";
    el.classList.add("stale");
  } else if (last === 0) {
    el.textContent = "Données du snapshot embarqué (hors ligne).";
    el.classList.add("stale");
  } else {
    const days = (Date.now() - last) / 86_400_000;
    el.textContent = `Données du ${new Date(last).toLocaleDateString("fr-FR")}`;
    el.classList.toggle("stale", days > 2);
    if (days > 2) el.textContent += " — API peut-être indisponible, affichage du cache.";
  }
}

/* ------------------------------ recherche ---------------------------- */

const input = $("search-input");
const resultsEl = $("results");
const emptyEl = $("empty-state");
let searchTimer;

input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120); // debounce léger
});

async function runSearch() {
  const q = input.value;
  const [poligraph, maires] = await Promise.all([
    searchPolitiques(q),
    searchMaires(q, 6),
  ]);
  // Poligraph d'abord (fiches complètes), puis maires RNE non doublonnés.
  const seen = new Set(poligraph.map((p) => fold(p._displayName)));
  const rows = [...poligraph, ...maires.filter((m) => !seen.has(fold(m._displayName)))];

  resultsEl.replaceChildren();
  emptyEl.hidden = rows.length > 0;
  if (q.trim().length >= 2 && rows.length === 0) {
    const d = await storeDiagnostics();
    let msg = `Aucun représentant trouvé. Données locales : ${d.politiques} profils Poligraph, ${d.maires} maires RNE.`;
    if (d.maires <= 0) {
      msg += " ⚠ Le fichier des maires (RNE) n'est pas chargé — cliquez sur ⟳, et vérifiez dans about:addons → Permissions que l'accès à data.gouv.fr est activé.";
    } else if (d.lastRNERefresh) {
      msg += ` (RNE du ${new Date(d.lastRNERefresh).toLocaleDateString("fr-FR")} — fichier ministériel trimestriel : les élus très récents peuvent manquer.)`;
    }
    emptyEl.textContent = msg;
  } else {
    emptyEl.textContent = "Tapez au moins deux lettres pour chercher parmi les représentants indexés (Poligraph + maires du RNE).";
  }

  for (const row of rows) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.setAttribute("role", "option");

    const name = document.createElement("span");
    name.className = "r-name";
    name.textContent = row._displayName;

    const meta = document.createElement("span");
    meta.className = "r-meta";
    let bits;
    if (row._source === "rne") {
      bits = [`Maire · ${row.commune}`];
    } else {
      bits = [row.party || row.wikidataParty, row.mandate].filter(Boolean);
      if (row.affairsCount > 0) bits.push(`${row.affairsCount} affaire${row.affairsCount > 1 ? "s" : ""}`);
    }
    meta.textContent = bits.join(" · ");

    li.append(name, meta);
    li.addEventListener("click", () => openFiche(row));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") openFiche(row); });
    resultsEl.append(li);
  }
}

function fold(s) {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* -------------------------------- fiche ------------------------------ */

/* Absence de données ≠ probité : rappel systématique (charte Poligraph). */
const NO_DATA_SUFFIX = " L'absence d'information ne préjuge pas de la réalité.";

async function openFiche(pol) {
  viewSearch.hidden = true;
  viewFiche.hidden = false;
  window.scrollTo(0, 0);
  resetContact();

  if (pol._source === "rne") return openFicheMaire(pol);
  $("poligraph-sections").hidden = false;
  $("fiche-note").hidden = true;

  /* ---- identité ---- */
  $("fiche-name").textContent = pol._displayName;
  const subBits = [pol.mandateTitle || pol.mandate, pol.party || pol.wikidataParty].filter(Boolean);
  if (pol.deathDate) subBits.push(`✝ ${frDate(pol.deathDate)}`);
  $("fiche-sub").textContent = subBits.join(" · ") || "Mandat non renseigné.";
  const photo = $("fiche-photo");
  photo.hidden = !pol.photo;
  if (pol.photo) photo.src = pol.photo;
  $("fiche-link").href = pol.profileUrl || canonicalUrl(pol.poligraphId);
  $("fiche-link").textContent = "Voir la fiche complète sur poligraph.fr ↗";

  /* ---- bouton suivre ---- */
  const followBtn = $("btn-follow");
  followBtn.hidden = false;
  const follows = await getFollows();
  const paint = (on) => { followBtn.textContent = on ? "★" : "☆"; followBtn.classList.toggle("on", on); };
  paint(!!follows[pol.poligraphId]);
  followBtn.onclick = async () => {
    const on = await toggleFollow(pol.poligraphId, pol._displayName);
    paint(on);
    browser.runtime.sendMessage({ type: "check-rss-now" }).catch(() => {});
  };

  /* ---- en bref ---- */
  const infos = [];
  if (pol.partyFull) infos.push(["Parti", pol.partyFull + (pol.position ? ` (${pol.position.toLowerCase()})` : "")]);
  else if (pol.wikidataParty) infos.push(["Parti", `${pol.wikidataParty} — source : Wikidata`]);
  else if (pol.position) infos.push(["Position", pol.position]);
  if (pol.mandate) infos.push(["Mandat", pol.mandateTitle || pol.mandate]);
  if (pol.mandateStart) infos.push(["Depuis", frDate(pol.mandateStart)]);
  const terr = [pol.constituency, pol.department ? `dépt. ${pol.department}` : null].filter(Boolean).join(", ");
  if (terr) infos.push(["Territoire", terr]);
  if (pol.birthDate) {
    const nee = pol.civility === "Mme" ? "Née" : "Né(e)";
    infos.push([nee, frDate(pol.birthDate) + (pol.birthPlace ? ` à ${pol.birthPlace}` : "")]);
  }
  if (pol.deathDate) infos.push(["Décès", frDate(pol.deathDate)]);
  const dl = $("fiche-infos");
  dl.replaceChildren();
  for (const [k, v] of infos) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
  dl.hidden = infos.length === 0;

  /* ---- affaires (récentes d'abord, paginées) ---- */
  const affaires = (await affairesFor(pol.poligraphId))
    .sort((a, b) => dateKey(b.verdictDate || b.factsDate) - dateKey(a.verdictDate || a.factsDate));
  $("count-affaires").textContent = affaires.length ? `(${affaires.length})` : "";
  renderPaginated("affaires", affaires, (a) => {
    // Le rôle dans l'affaire est une info capitale : mis en cause ≠ victime.
    const extra = a.involvementCode && a.involvementCode !== "DIRECT"
      ? { label: a.involvement || a.involvementCode, cls: "gris mini" }
      : null;
    const partyNote = a.partyAtTime && a.partyAtTime !== a.currentParty
      ? `parti au moment des faits : ${a.partyAtTime}` : null;
    return {
      title: a.title || a.category || "Affaire",
      timbre: { label: a.status || "Statut inconnu", cls: timbreClass(a.statusCode) },
      extraTimbre: extra,
      meta: [a.severity, (a.verdictDate || a.factsDate) ? frDate(a.verdictDate || a.factsDate) : null, partyNote,
        a.sourceCount ? `${a.sourceCount} source${a.sourceCount > 1 ? "s" : ""}` : null]
        .filter(Boolean).join(" · "),
      href: a.pageUrl || (a.poligraphId ? canonicalUrl(a.poligraphId) : null),
    };
  }, "Aucune affaire recensée dans les données locales." + NO_DATA_SUFFIX);

  /* ---- fact-checks (récents d'abord, paginés) ---- */
  const fchecks = (await factchecksFor(pol.poligraphId))
    .sort((a, b) => dateKey(b.date) - dateKey(a.date));
  $("count-factchecks").textContent = fchecks.length ? `(${fchecks.length})` : "";
  renderPaginated("factchecks", fchecks, (f) => ({
    title: f.title || "Fact-check",
    timbre: { label: f.verdict || "?", cls: verdictClass(f.verdictCode) },
    // Auteur de la déclaration vérifiée, ou simplement cité dans le texte ?
    extraTimbre: f.authorDirect
      ? { label: "auteur", cls: "gris mini" }
      : { label: "mentionné·e", cls: "gris mini" },
    meta: [f.factChecker, f.date ? frDate(f.date) : null].filter(Boolean).join(" · "),
    href: f.url || f.pageUrl || null,
  }), "Aucun fact-check recensé dans les données locales." + NO_DATA_SUFFIX);

  /* ---- contact + bio + activité + transparence (asynchrones) ---- */
  loadContactPoligraph(pol);
  loadBio(pol);
  loadHatvp(pol._displayName);

  /* ---- votes (API à la demande + cache hors ligne) ---- */
  await renderVotes(pol);
}

/* ------------------------- fiche maire (RNE) ------------------------- */

async function openFicheMaire(m) {
  $("poligraph-sections").hidden = true;
  $("btn-follow").hidden = true; // les flux Poligraph ne couvrent pas le RNE

  $("fiche-name").textContent = m.fullName;
  $("fiche-sub").textContent = `Maire de ${m.commune}`;
  const photo = $("fiche-photo");
  photo.hidden = true;
  $("fiche-link").href = "https://www.data.gouv.fr/datasets/repertoire-national-des-elus-1";
  $("fiche-link").textContent = "Source : Répertoire national des élus ↗";

  const infos = [];
  infos.push(["Commune", `${m.commune} (${m.communeInsee})`]);
  if (m.departement) infos.push(["Département", m.departement]);
  if (m.profession) infos.push(["Profession", m.profession]);
  // Sobriété : l'âge plutôt que la date de naissance complète (élu local).
  const age = ageFrom(m.birthDate);
  if (age) infos.push(["Âge", `${age} ans`]);
  if (m.fonctionStart || m.mandateStart) infos.push(["Maire depuis", frDate(m.fonctionStart || m.mandateStart)]);
  fillDl($("fiche-infos"), infos);
  $("fiche-infos").hidden = infos.length === 0;

  const note = $("fiche-note");
  note.hidden = false;
  note.textContent = "Élu·e référencé·e via le Répertoire national des élus (ministère de l'Intérieur). " +
    "Pas de suivi Poligraph (affaires, fact-checks, votes) pour cet·te élu·e — " +
    "l'absence d'information ne préjuge pas de la réalité. Le RNE ne publie pas d'étiquette politique.";

  /* Contact mairie (DILA), à la demande avec cache. */
  setContact([["Mairie", { text: "recherche en cours…" }]], false);
  loadDeliberations(m.communeInsee, m.commune);
  loadHatvp(m.fullName);
  try {
    console.info(`[Poligraph] contact mairie : commune=${m.commune} insee=${m.communeInsee}`);

    // La permission d'hôte est-elle accordée ? (Firefox MV3 ne les
    // accorde pas automatiquement — surtout après une mise à jour.)
    const granted = await browser.permissions.contains({
      origins: ["https://api-lannuaire.service-public.fr/*"],
    }).catch(() => true); // API permissions absente : on tente quand même
    if (!granted) {
      console.warn("[Poligraph] permission api-lannuaire NON accordée");
      return setContact([["Mairie", {
        text: "accès non autorisé. Ouvrez about:addons → Poligraph Companion → onglet Permissions, et activez l'accès aux sites.",
      }]], true);
    }

    const c = await mairieContactFor(m.communeInsee, m.commune);
    console.info("[Poligraph] contact mairie résultat :", c);
    if (!c) return setContact([["Mairie", { text: "non trouvée dans l'Annuaire de l'administration." }]], true);
    const rows = [];
    if (c.courriel) rows.push(["Courriel", { link: `mailto:${c.courriel}`, text: c.courriel }]);
    if (c.site) rows.push(["Site", { link: c.site, text: c.site.replace(/^https?:\/\//, "") }]);
    if (c.telephone) rows.push(["Téléphone", { text: c.telephone }]);
    if (c.adresse) rows.push(["Adresse", { text: c.adresse }]);
    if (c.fiche) rows.push(["Fiche", { link: c.fiche, text: "annuaire service-public.fr" }]);
    setContact(rows, true, "Contacter la mairie — source : Annuaire de l'administration (DILA)");
  } catch (err) {
    console.error("[Poligraph] contact mairie ERREUR :", err);
    setContact([["Mairie", { text: `erreur : ${err.message}` }]], true);
  }
}

/* --------------------------- section contact ------------------------- */

function resetContact() {
  $("contact-title").hidden = true;
  $("fiche-contact").hidden = true;
  $("fiche-contact").replaceChildren();
  $("contact-title").textContent = "Contact";
  $("fiche-bio").hidden = true;
  $("fiche-bio").replaceChildren();
  $("activite-title").hidden = true;
  $("fiche-activite").hidden = true;
  $("fiche-activite").replaceChildren();
  $("delib-title").hidden = true;
  $("fiche-delib").hidden = true;
  $("fiche-delib").replaceChildren();
  $("hatvp-title").hidden = true;
  $("hatvp-note").hidden = true;
  $("fiche-hatvp").hidden = true;
  $("fiche-hatvp").replaceChildren();
  $("pager-hatvp").hidden = true;
}

/**
 * Transparence HATVP. La section n'apparaît QUE si des déclarations
 * existent : afficher « aucune déclaration » sur chaque élu local
 * suggérerait à tort un manquement, alors que la plupart des élus
 * ne sont simplement pas assujettis à la publication.
 */
async function loadHatvp(fullName) {
  try {
    const rows = await hatvpFor(fullName);
    if (rows.length === 0) return;
    $("hatvp-title").hidden = false;
    $("hatvp-note").hidden = false;
    $("fiche-hatvp").hidden = false;
    renderPaginated("hatvp", rows, (d) => ({
      title: d.docLabel + (d.enCoursDePublication ? " (en cours de publication)" : ""),
      timbre: { label: d.mandatLabel || "—", cls: "gris mini" },
      meta: [d.qualite, (d.dateDepot || d.datePublication) ? `déposée le ${frDate(d.dateDepot || d.datePublication)}` : null,
        d.departement ? `dépt. ${d.departement}` : null].filter(Boolean).join(" · "),
      href: d.urlDossier,
    }), "");
  } catch { /* store absent : section masquée */ }
}

/** Délibérations & actes publiés en open data pour une commune (liens). */
async function loadDeliberations(codeInsee, communeName) {
  if (!codeInsee || !communeName) return;
  try {
    const items = await deliberationsFor(codeInsee, communeName);
    const ul = $("fiche-delib");
    ul.replaceChildren();
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = "Aucune publication open data trouvée pour cette commune sur data.gouv.fr — la plupart des communes ne publient pas encore leurs délibérations.";
      ul.append(li);
    } else {
      for (const item of items) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = "c-title";
        a.href = item.url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = item.title;
        const m = document.createElement("div");
        m.className = "c-meta";
        m.textContent = [item.org, "catalogue data.gouv.fr"].filter(Boolean).join(" · ");
        li.append(a, m);
        ul.append(li);
      }
    }
    $("delib-title").hidden = false;
    ul.hidden = false;
  } catch { /* hors ligne : section absente, sans bruit */ }
}

/** Bio Wikipédia (contenu contributif, source affichée), à la demande. */
async function loadBio(pol) {
  if (!pol.wikidataId) return;
  try {
    const bio = await bioFor(pol.wikidataId);
    if (!bio?.extract) return;
    const p = $("fiche-bio");
    p.replaceChildren(document.createTextNode(bio.extract + " "));
    const src = document.createElement("span");
    src.className = "src";
    src.append("— ");
    const a = document.createElement("a");
    a.href = bio.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "Wikipédia";
    src.append(a, " (contenu contributif)");
    p.append(src);
    p.hidden = false;
  } catch { /* hors ligne : la fiche vit très bien sans bio */ }
}

/** Activité parlementaire — scores Datan (législature) ou compteurs. */
function renderActivity(parl) {
  const s = parl?.stats;
  console.info("[Poligraph] activité parlementaire :", parl?.chambre, s);
  if (!s) {
    if (parl?.chambre === "Sénat") return; // pas de stats pour les sénateurs (source figée)
    fillDl($("fiche-activite"), [["Activité", "indisponible — cliquez ⟳ pour reconstruire l'index (rapport par source en haut du popup)."]]);
    $("activite-title").hidden = false;
    $("fiche-activite").hidden = false;
    return;
  }
  const rows = [];
  if (s.type === "scores") {
    const add = (label, v, note = "") => { if (v !== null && v !== undefined) rows.push([label, `${v} %${note}`]); };
    add("Participation", s.participation, " des scrutins publics");
    add("Spécialité", s.participationSpecialite, " (scrutins de sa commission)");
    add("Loyauté", s.loyaute, " de votes alignés sur son groupe");
    add("Majorité", s.majorite, " de votes alignés sur la majorité");
    if (s.mandats) rows.push(["Mandats", `${s.mandats} mandat${s.mandats > 1 ? "s" : ""} de député`]);
    if (rows.length === 0) return;
    rows.push(["Source", `${parl.source} — scores descriptifs sur la législature, pas des notes`]);
  } else {
    const add = (label, v, suffix = "") => { if (v !== null && v !== undefined) rows.push([label, `${v}${suffix}`]); };
    add("Présence", s.semainesPresence, " sem.");
    add("Commissions", s.presencesCommission);
    add("Interventions", s.interventionsHemicycle);
    if (s.amendementsProposes !== null) {
      rows.push(["Amendements", `${s.amendementsProposes} proposés${s.amendementsAdoptes !== null ? `, ${s.amendementsAdoptes} adoptés` : ""}`]);
    }
    add("Rapports", s.rapports);
    if (rows.length === 0) return;
    rows.push(["Source", `${parl.source} — indicateurs bruts, non comparables entre élus`]);
  }
  fillDl($("fiche-activite"), rows);
  $("activite-title").hidden = false;
  $("fiche-activite").hidden = false;
}

function setContact(rows, ready, title) {
  const dl = $("fiche-contact");
  dl.replaceChildren();
  if (title) $("contact-title").textContent = title;
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd");
    if (v.link) {
      const a = document.createElement("a");
      a.href = v.link; a.textContent = v.text;
      if (!v.link.startsWith("mailto:")) { a.target = "_blank"; a.rel = "noopener"; }
      dd.append(a);
    } else {
      dd.textContent = v.text;
    }
    if (v.src) {
      const s = document.createElement("span");
      s.className = "src"; s.textContent = ` — ${v.src}`;
      dd.append(s);
    }
    dl.append(dt, dd);
  }
  $("contact-title").hidden = rows.length === 0;
  dl.hidden = rows.length === 0;
}

/** Contact d'un profil Poligraph : Wikidata + parlement + ministère + mairie. */
async function loadContactPoligraph(pol) {
  const rows = [];

  if (pol.wikidataWebsite) {
    rows.push(["Site officiel", { link: pol.wikidataWebsite, text: pol.wikidataWebsite.replace(/^https?:\/\//, ""), src: "Wikidata" }]);
  }
  if (pol.wikidataEmail) {
    rows.push(["Courriel", { link: `mailto:${pol.wikidataEmail}`, text: pol.wikidataEmail, src: "Wikidata" }]);
  }

  /* Parlementaire ? (index NosDéputés/NosSénateurs, local) */
  try {
    const parl = await parlementContactFor(pol._displayName);
    console.info(`[Poligraph] index parlementaire pour « ${pol._displayName} » :`, parl ? "trouvé" : "absent");
    if (parl) {
      if (parl.email) rows.push([`Courriel ${parl.chambre === "Sénat" ? "Sénat" : "AN"}`,
        { link: `mailto:${parl.email}`, text: parl.email, src: parl.source }]);
      if (parl.site && !pol.wikidataWebsite) {
        rows.push(["Site", { link: parl.site, text: parl.site.replace(/^https?:\/\//, ""), src: parl.source }]);
      }
      renderActivity(parl);
    } else if (/d[ée]put|s[ée]nat/i.test(pol.mandateTitle || pol.mandate || "")) {
      // Parlementaire d'après son mandat, mais absent de l'index :
      // l'index n'est probablement pas construit. Le dire, pas le taire.
      fillDl($("fiche-activite"), [["Activité", "index parlementaire non construit — cliquez ⟳ et lisez le rapport par source en haut du popup."]]);
      $("activite-title").hidden = false;
      $("fiche-activite").hidden = false;
    }
  } catch { /* index absent : ignorer */ }

  if (rows.length) setContact(rows, true);

  const title = pol.mandateTitle || pol.mandate || "";

  /* Maire ? → contact de la mairie. Poligraph inclut des maires, avec
     le code INSEE dans la circonscription (ex. « Cabidos (64158) »). */
  if (/^maire\b/i.test(title)) {
    const insee = (pol.constituency ?? "").match(/\((\d{5}[a-zA-Z]?)\)/)?.[1]
      ?? (pol.mandate ?? "").match(/\((\d{5}[a-zA-Z]?)\)/)?.[1];
    if (insee) {
      const communeName = (title.match(/^maire\s+(?:de\s+|d')?(.+)$/i)?.[1] ?? "").trim();
      loadDeliberations(insee, communeName);
      try {
        const c = await mairieContactFor(insee, communeName);
        if (c) {
          const extra = [];
          if (c.courriel) extra.push(["Courriel mairie", { link: `mailto:${c.courriel}`, text: c.courriel, src: "Annuaire DILA" }]);
          if (c.site) extra.push(["Site mairie", { link: c.site, text: c.site.replace(/^https?:\/\//, ""), src: "Annuaire DILA" }]);
          if (c.telephone) extra.push(["Téléphone mairie", { text: c.telephone, src: "Annuaire DILA" }]);
          if (extra.length) setContact([...rows, ...extra], true, "Contact — coordonnées institutionnelles");
        }
      } catch (err) {
        console.warn("[Poligraph] contact mairie (profil Poligraph) :", err.message);
      }
    }
  }

  /* Ministre ? → contact du ministère (DILA, à la demande). */
  if (/ministre/i.test(title)) {
    try {
      const { getMinistereContact } = await import("../lib/annuaire.js");
      const c = await getMinistereContact(title);
      if (c) {
        const extra = [];
        if (c.site) extra.push([`Ministère`, { link: c.site, text: c.nom || c.site.replace(/^https?:\/\//, ""), src: "Annuaire DILA" }]);
        if (c.courriel) extra.push(["Courriel ministère", { link: `mailto:${c.courriel}`, text: c.courriel, src: "Annuaire DILA" }]);
        if (extra.length) setContact([...rows, ...extra], true);
      }
    } catch { /* hors ligne : ignorer */ }
  }
}

function ageFrom(birthDate) {
  const d = new Date(birthDate);
  if (isNaN(d)) return null;
  const age = Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
  return age > 17 && age < 110 ? age : null;
}

function fillDl(dl, infos) {
  dl.replaceChildren();
  for (const [k, v] of infos) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
}

/* Votes : POUR/CONTRE/... → timbres. Vert/rouge = position, pas jugement. */
function positionTimbre(position) {
  const map = {
    POUR: ["Pour", "vert"],
    CONTRE: ["Contre", "rouge"],
    ABSTENTION: ["Abstention", "ambre"],
    NON_VOTANT: ["Non votant", "gris"],
    ABSENT: ["Absent", "gris"],
  };
  const [label, cls] = map[position] ?? [position ?? "?", "gris"];
  return { label, cls };
}

async function renderVotes(pol) {
  const statsEl = $("votes-stats");
  statsEl.hidden = true;
  $("count-votes").textContent = "";
  renderPaginated("votes", [], () => ({}), "Chargement des votes…");

  let payload = null;
  let fromCache = false;
  try {
    payload = await fetchVotesJSON(pol.slug);
    await setCachedVotes(pol.slug, payload);
  } catch {
    const cached = await getCachedVotes(pol.slug);
    if (cached) { payload = cached.payload; fromCache = true; }
  }

  if (!payload) {
    renderPaginated("votes", [], () => ({}),
      "Votes indisponibles hors ligne (ils sont récupérés en direct depuis Poligraph).");
    return;
  }

  const { stats, votes, pagination } = payload;
  if (stats && typeof stats.participationRate === "number") {
    statsEl.hidden = false;
    statsEl.textContent =
      `Participation : ${Math.round(stats.participationRate)} % — ` +
      `${stats.pour ?? 0} pour · ${stats.contre ?? 0} contre · ` +
      `${stats.abstention ?? 0} abst.` +
      (fromCache ? " (données en cache)" : "");
  }
  const total = pagination?.total ?? votes.length;
  $("count-votes").textContent = total ? `(${total})` : "";

  renderPaginated("votes", votes ?? [], (v) => ({
    title: v.scrutin?.title || "Scrutin",
    timbre: positionTimbre(v.position),
    meta: [
      v.scrutin?.votingDate ? frDate(v.scrutin.votingDate) : null,
      v.scrutin?.result,
      v.scrutin?.legislature ? `${v.scrutin.legislature}e lég.` : null,
    ].filter(Boolean).join(" · "),
    href: v.scrutin?.sourceUrl || null,
  }), "Aucun vote parlementaire recensé (mandat non parlementaire, ou données absentes)." + NO_DATA_SUFFIX);
}

function frDate(s) {
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString("fr-FR");
}
function dateKey(s) {
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

/* ------------------------- listes paginées --------------------------- */

const PAGE_SIZE = 3;
const pagerState = {}; // { affaires: {rows, mapFn, empty, page}, factchecks: {...} }

function renderPaginated(kind, rows, mapFn, emptyText) {
  pagerState[kind] = { rows, mapFn, emptyText, page: 0 };
  drawPage(kind);
}

function drawPage(kind) {
  const st = pagerState[kind];
  const container = $(`fiche-${kind}`);
  const pager = $(`pager-${kind}`);
  const totalPages = Math.max(1, Math.ceil(st.rows.length / PAGE_SIZE));
  st.page = Math.min(st.page, totalPages - 1);

  renderCards(container, st.rows.slice(st.page * PAGE_SIZE, (st.page + 1) * PAGE_SIZE), st.mapFn, st.emptyText);

  pager.hidden = st.rows.length <= PAGE_SIZE;
  if (pager.hidden) return;
  pager.replaceChildren();

  const prev = document.createElement("button");
  prev.textContent = "‹";
  prev.disabled = st.page === 0;
  prev.setAttribute("aria-label", "Page précédente");
  prev.addEventListener("click", () => { st.page--; drawPage(kind); });

  const label = document.createElement("span");
  label.textContent = `${st.page + 1} / ${totalPages}`;

  const next = document.createElement("button");
  next.textContent = "›";
  next.disabled = st.page >= totalPages - 1;
  next.setAttribute("aria-label", "Page suivante");
  next.addEventListener("click", () => { st.page++; drawPage(kind); });

  pager.append(prev, label, next);
}

function verdictClass(code) {
  if (["TRUE", "MOSTLY_TRUE"].includes(code)) return "vert";
  if (["HALF_TRUE", "MISLEADING", "OUT_OF_CONTEXT", "UNVERIFIABLE"].includes(code)) return "ambre";
  if (["MOSTLY_FALSE", "FALSE"].includes(code)) return "rouge";
  return "gris";
}

function renderCards(container, rows, mapFn, emptyText) {
  container.replaceChildren();
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = emptyText;
    container.append(li);
    return;
  }
  for (const row of rows) {
    const { title, timbre, extraTimbre, meta, href } = mapFn(row);
    const li = document.createElement("li");

    const t = document.createElement(href ? "a" : "span");
    t.className = "c-title";
    t.textContent = title;
    if (href) { t.href = href; t.target = "_blank"; t.rel = "noopener"; }

    const stamp = document.createElement("span");
    stamp.className = `timbre ${timbre.cls}`;
    stamp.textContent = timbre.label;
    li.append(t, stamp);

    if (extraTimbre) {
      const extra = document.createElement("span");
      extra.className = `timbre ${extraTimbre.cls}`;
      extra.textContent = extraTimbre.label;
      li.append(extra);
    }

    const m = document.createElement("div");
    m.className = "c-meta";
    m.textContent = meta;
    li.append(m);

    container.append(li);
  }
}

$("btn-back").addEventListener("click", () => {
  viewFiche.hidden = true;
  viewSearch.hidden = false;
  input.focus();
});

/* --------------------------- rafraîchissement ------------------------ */

$("btn-chat").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("chat/chat.html") });
  window.close();
});

$("btn-compare").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("compare/compare.html") });
  window.close();
});

/* ---------------------- détection sur les pages ---------------------- */

$("detect-toggle").addEventListener("change", async (e) => {
  await browser.storage.local.set({ detectEnabled: e.target.checked });
});

/* ----------------------------- suivi RSS ----------------------------- */

async function renderSuivi() {
  const items = await getSuiviItems();
  if (items.length === 0) return;
  const unread = items.filter((i) => i.unread).length;
  $("suivi-title").hidden = false;
  $("suivi-list").hidden = false;
  $("suivi-count").textContent = unread ? `(${unread} nouveau${unread > 1 ? "x" : ""})` : "";
  const ul = $("suivi-list");
  ul.replaceChildren();
  for (const item of items.slice(0, 6)) {
    const li = document.createElement("li");
    if (item.unread) li.style.borderColor = "var(--encre)";
    const a = document.createElement("a");
    a.className = "c-title";
    a.href = item.link; a.target = "_blank"; a.rel = "noopener";
    a.textContent = item.title;
    const m = document.createElement("div");
    m.className = "c-meta";
    m.textContent = [item.feedLabel, item.matchedName, item.date ? frDate(item.date) : null]
      .filter(Boolean).join(" · ");
    li.append(a, m);
    ul.append(li);
  }
  // Consultée = lue : on efface le badge.
  if (unread) {
    await markSuiviRead();
    browser.runtime.sendMessage({ type: "badge-refresh" }).catch(() => {});
  }
}

$("btn-refresh").addEventListener("click", async () => {
  const btn = $("btn-refresh");
  btn.disabled = true; btn.textContent = "…";
  const el = $("data-age");
  el.hidden = false;
  el.textContent = "Rafraîchissement en cours (peut prendre ~30 s)…";
  const res = await browser.runtime.sendMessage({ type: "refresh-now" });
  btn.disabled = false; btn.textContent = "⟳";
  if (res?.report) {
    const r = res.report;
    el.textContent = `Poligraph ${r.poligraph} · Wikidata ${r.wikidata} · RNE ${r.rne} · Parlement ${r.parlement} · HATVP ${r.hatvp}`;
    el.classList.toggle("stale", Object.values(r).some((v) => String(v).startsWith("✗")));
    runSearch();
  } else {
    el.textContent = `Rafraîchissement en échec : ${res?.error ?? "raison inconnue"}`;
    el.classList.add("stale");
  }
});

/* ------------------------------ démarrage ---------------------------- */

(async function init() {
  await seedFromSnapshotIfEmpty();
  await renderDataAge();

  // Version visible : permet de vérifier d'un coup d'œil quelle build tourne.
  const v = browser.runtime.getManifest().version;
  document.querySelector(".legal").append(` v${v}`);

  const { detectEnabled } = await browser.storage.local.get("detectEnabled");
  $("detect-toggle").checked = !!detectEnabled;
  renderSuivi();

  // Sélection transmise par le menu contextuel ?
  const { pendingQuery } = await browser.storage.session.get("pendingQuery");
  if (pendingQuery) {
    await browser.storage.session.remove("pendingQuery");
    input.value = pendingQuery;
    runSearch();
  }
})();
