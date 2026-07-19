/**
 * Contacts et activité des parlementaires.
 *
 * DÉPUTÉS — source principale : Datan (data.gouv.fr, hebdomadaire,
 * licence ouverte, données issues de l'open data officiel de l'AN).
 * Un seul CSV léger : courriel, site, groupe, et scores d'activité
 * (participation aux scrutins, loyauté au groupe, proximité majorité).
 * NB : NosDéputés.fr est figé depuis la dissolution de juin 2024
 * (endpoint « enmandat » vide) — abandonné comme source.
 *
 * SÉNATEURS — NosSénateurs.fr tenté en best-effort (peut être figé
 * aussi) : son absence ne fait pas échouer l'index.
 */

import { parseCSV } from "./csv.js";

const DATAN_DEPUTES_URL =
  "https://www.data.gouv.fr/api/1/datasets/r/092bd7bb-1543-405b-b53c-932ebb49bb8e";

const NOSSENATEURS_URL = "https://www.nossenateurs.fr/senateurs/enmandat/json";

const SOCIAL = /twitter\.com|x\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|bsky\.app|tiktok\.com/i;

function fold(s) {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function detectDelimiter(text) {
  const firstLine = text.slice(0, text.indexOf("\n"));
  const counts = { ";": 0, ",": 0, "\t": 0 };
  for (const c of firstLine) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Score en pourcentage entier, tolérant fraction 0-1 et virgule décimale. */
function pct(v) {
  if (v === undefined || v === null || v === "") return null;
  const num = Number(String(v).replace(",", "."));
  if (isNaN(num)) return null;
  return Math.round(num <= 1 ? num * 100 : num);
}

/**
 * Construit l'index { nomPlié → contact + stats }.
 * Lève une erreur détaillée seulement si AUCUNE source n'a rien donné.
 */
export async function fetchParlementIndex() {
  const index = {};
  const errors = [];

  /* -------- Députés : Datan (CSV) -------- */
  try {
    const res = await fetch(DATAN_DEPUTES_URL, { headers: { Accept: "text/csv" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text, { delimiter: detectDelimiter(text) });
    for (const r of rows) {
      const nom = [r.prenom, r.nom].filter(Boolean).join(" ");
      if (!nom.trim()) continue;
      const email = (r.mail ?? "").trim() || null;
      const website = (r.website ?? "").trim();
      index[fold(nom)] = {
        email: email && email.includes("@") ? email : null,
        site: website && !SOCIAL.test(website) ? website : null,
        chambre: "Assemblée nationale",
        source: "Datan (open data AN)",
        stats: {
          type: "scores",
          participation: pct(r.scoreParticipation),
          participationSpecialite: pct(r.scoreParticipationSpectialite ?? r.scoreParticipationSpecialite),
          loyaute: pct(r.scoreLoyaute),
          majorite: pct(r.scoreMajorite),
          mandats: r.nombreMandats ? Number(r.nombreMandats) : null,
          groupe: r.groupeAbrev || r.groupe || null,
        },
      };
    }
    if (rows.length === 0) errors.push("Datan : CSV vide");
  } catch (err) {
    errors.push(`Datan : ${err.message}`);
  }

  /* -------- Sénateurs : NosSénateurs (best-effort) -------- */
  try {
    const res = await fetch(NOSSENATEURS_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const wrapper of data.senateurs ?? []) {
      const p = wrapper.senateur;
      if (!p?.nom) continue;
      const email = (p.emails ?? []).map((e) => e.email)
        .find((e) => e && e.toLowerCase().endsWith("@senat.fr")) ?? null;
      const site = (p.sites_web ?? []).map((s) => s.site)
        .find((s) => s && !SOCIAL.test(s)) ?? null;
      if (!index[fold(p.nom)]) {
        index[fold(p.nom)] = {
          email, site, stats: null,
          chambre: "Sénat", source: "NosSénateurs.fr",
        };
      }
    }
  } catch (err) {
    errors.push(`NosSénateurs : ${err.message}`);
  }

  if (Object.keys(index).length === 0) {
    throw new Error(errors.join(" · ") || "aucune source disponible");
  }
  return index;
}

/** Recherche dans l'index par nom complet (plié). */
export function lookupParlement(index, fullName) {
  return index?.[fold(fullName)] ?? null;
}
