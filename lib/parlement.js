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

/* Open data officiel du Sénat (licence ouverte). NosSénateurs.fr,
   projet civique probablement figé comme NosDéputés, est abandonné
   au profit de la source institutionnelle. */
const SENAT_URL = "https://data.senat.fr/data/senateurs/ODSEN_GENERAL.csv";

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

/** Identifiant ou URL → URL canonique du réseau. */
function socialUrl(value, base) {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  return `${base}${encodeURIComponent(v.replace(/^@/, ""))}`;
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
      const socials = {};
      const tw = socialUrl(r.twitter, "https://x.com/");
      const fb = socialUrl(r.facebook, "https://www.facebook.com/");
      if (tw) socials.twitter = tw;
      if (fb) socials.facebook = fb;
      index[fold(nom)] = {
        email: email && email.includes("@") ? email : null,
        site: website && !SOCIAL.test(website) ? website : null,
        socials,
        // Page officielle standardisée : id acteur AN (format PAxxxxx,
        // vérifié dans les fichiers Datan) → assemblee-nationale.fr/dyn/deputes/PAxxxxx
        officialUrl: /^PA\d+$/.test((r.id ?? "").trim())
          ? `https://www.assemblee-nationale.fr/dyn/deputes/${r.id.trim()}`
          : null,
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

  /* -------- Sénateurs : open data officiel du Sénat -------- */
  /* ODSEN_GENERAL.csv : encodage ISO-8859-1, lignes de préambule « % »,
     colonne « Courrier électronique » = adresse OU « Non public » selon
     le consentement du sénateur — on respecte ce choix à la lettre. */
  try {
    const res = await fetch(SENAT_URL, { headers: { Accept: "text/csv" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("\ufffd")) text = new TextDecoder("iso-8859-1").decode(buf);
    text = text.split(/\r?\n/).filter((l) => !l.startsWith("%")).join("\n");

    const rows = parseCSV(text, { delimiter: detectDelimiter(text) });
    const col = (r, needle) => {
      const k = Object.keys(r).find((key) => fold(key).includes(needle));
      return k ? (r[k] ?? "").trim() : "";
    };
    let actifs = 0;
    for (const r of rows) {
      const etat = col(r, "tat"); // « État » (accent variable selon décodage)
      if (etat && fold(etat) !== "actif") continue;
      const nom = [col(r, "prenom usuel"), col(r, "nom usuel")].filter(Boolean).join(" ");
      if (!nom.trim()) continue;
      actifs++;
      const emailRaw = col(r, "courrier");
      const email = emailRaw.includes("@") ? emailRaw : null; // « Non public » écarté

      /* Page officielle standardisée du Sénat :
         senat.fr/senateur/{nom}_{prenom}{matricule}.html — motif vérifié
         sur des fiches réelles (ex. aeschlimann_marie_do21071f.html). */
      const matricule = col(r, "matricule").toLowerCase();
      const slug = (s) => fold(s).replace(/[\s'’-]+/g, "_").replace(/[^a-z0-9_]/g, "");
      const officialUrl = matricule
        ? `https://www.senat.fr/senateur/${slug(col(r, "nom usuel"))}_${slug(col(r, "prenom usuel"))}${matricule}.html`
        : null;

      const key = fold(nom);
      if (!index[key]) {
        index[key] = {
          email, site: null, socials: {}, stats: null, officialUrl,
          chambre: "Sénat", source: "Sénat (open data)",
        };
      }
    }
    if (actifs === 0) errors.push("Sénat : aucun sénateur actif trouvé (format ?)");
  } catch (err) {
    errors.push(`Sénat : ${err.message}`);
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
