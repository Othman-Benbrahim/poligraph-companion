/**
 * Annuaire de l'administration (DILA / service-public.fr).
 * API Explore v2.1 (Opendatasoft), gratuite, licence ouverte.
 * Donne les coordonnées INSTITUTIONNELLES (mairie, ministère) —
 * jamais les coordonnées personnelles d'un élu. Intitulés d'UI en
 * conséquence : « Contacter la mairie », « Contacter le ministère ».
 */

const BASE = "https://api-lannuaire.service-public.fr/api/explore/v2.1/catalog/datasets/api-lannuaire-administration/records";

/** Certains champs de l'API sont des chaînes JSON : parse tolérant. */
function j(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function extractContact(record) {
  const f = record.fields ?? record;
  const sites = j(f.site_internet, []);
  const tels = j(f.telephone, []);
  const adresses = j(f.adresse, []);
  const a = Array.isArray(adresses) ? adresses[0] : null;
  return {
    nom: f.nom ?? null,
    courriel: f.adresse_courriel || null,
    site: Array.isArray(sites) && sites[0] ? (sites[0].valeur ?? sites[0]) : null,
    telephone: Array.isArray(tels) && tels[0] ? (tels[0].valeur ?? tels[0]) : null,
    adresse: a
      ? [a.numero_voie, a.code_postal, a.nom_commune].filter(Boolean).join(", ")
      : null,
    fiche: f.url_service_public || null,
  };
}

async function query(where, limit = 5) {
  const params = new URLSearchParams({ where, limit: String(limit) });
  const res = await fetch(`${BASE}?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) return null; // clause invalide → essayer la suivante
  if (!res.ok) throw new Error(`Annuaire HTTP ${res.status}`);
  const data = await res.json();
  return data.results ?? [];
}

/**
 * Contact de la mairie d'une commune. Cascade de requêtes, de la plus
 * précise à la plus large — le champ `pivot` est une chaîne JSON
 * contenant type de service ET code INSEE, donc interrogeable en texte
 * sans dépendre d'un champ aplati incertain :
 *   1. pivot contient "mairie" ET le code INSEE
 *   2. champ aplati code_insee_commune (si le dataset l'expose)
 *   3. nom du guichet contient "mairie" + nom de la commune
 */
export async function getMairieContact(codeInsee, communeName) {
  const attempts = [
    `pivot LIKE "mairie" AND pivot LIKE "${codeInsee}"`,
    `pivot LIKE "mairie" AND code_insee_commune="${codeInsee}"`,
  ];
  if (communeName) {
    attempts.push(`nom LIKE "mairie" AND nom LIKE "${communeName.replace(/"/g, "")}"`);
  }

  for (const where of attempts) {
    const results = await query(where);
    if (!results || results.length === 0) continue;
    // Écarter les mairies déléguées/annexes si une mairie principale existe.
    const principal = results.find((r) => !/deleguee|déléguée|annexe/i.test((r.fields ?? r).nom ?? ""));
    const hit = principal ?? results[0];
    return extractContact(hit);
  }
  return null;
}

/**
 * Contact d'un ministère, apparié par mots-clés du titre de mandat
 * (« Ministre de l'Intérieur » → ministère correspondant).
 * Appariement local sur la courte liste des ministères ; null si ambigu.
 */
export async function getMinistereContact(mandateTitle) {
  const keywords = (mandateTitle ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ministre( deleguee?| d'etat)*/g, "")
    .replace(/aupres du .* charge/g, "")
    .replace(/charge[e]? de/g, "")
    .split(/[\s,'’]+/)
    .filter((w) => w.length > 3);
  if (keywords.length === 0) return null;

  const results = await query(`pivot LIKE "ministere"`, 60);
  if (!results) return null;
  let best = null, bestScore = 0;
  for (const r of results) {
    const nom = ((r.fields ?? r).nom ?? "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const score = keywords.filter((w) => nom.includes(w)).length;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  // Exiger au moins 1 mot-clé apparié pour éviter les faux positifs.
  return bestScore >= 1 ? extractContact(best) : null;
}
