/**
 * Enrichissement via Wikidata — parti politique (propriété P102).
 *
 * L'export Poligraph fournit un Q-ID Wikidata par politicien, prévu
 * pour le croisement inter-jeux. Quand le parti manque côté Poligraph,
 * on le récupère ici. Deux phases, par lots de 50 (limite de l'API) :
 *   1. wbgetentities sur les Q-IDs des politiciens → claims P102
 *   2. wbgetentities sur les Q-IDs des partis → libellés français
 *
 * Source tierce : la provenance doit rester visible dans l'UI.
 */

const WD_API = "https://www.wikidata.org/w/api.php";
const BATCH = 50;

async function wbGetEntities(ids, props) {
  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: ids.join("|"),
    props,
    languages: "fr",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${WD_API}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const json = await res.json();
  return json.entities ?? {};
}

/**
 * Choisit la revendication P102 la plus pertinente :
 * rang "preferred" d'abord, sinon une adhésion sans date de fin (P582),
 * sinon la dernière déclarée.
 */
function pickPartyClaim(claims) {
  const p102 = claims?.P102;
  if (!Array.isArray(p102) || p102.length === 0) return null;
  const valid = p102.filter((c) => c.mainsnak?.datavalue?.value?.id);
  if (valid.length === 0) return null;
  const preferred = valid.find((c) => c.rank === "preferred");
  if (preferred) return preferred.mainsnak.datavalue.value.id;
  const current = valid.find((c) => !c.qualifiers?.P582);
  if (current) return current.mainsnak.datavalue.value.id;
  return valid[valid.length - 1].mainsnak.datavalue.value.id;
}

/** Première valeur chaîne valide d'une propriété (P856 site, P968 mail). */
function pickStringClaim(claims, prop) {
  const list = claims?.[prop];
  if (!Array.isArray(list)) return null;
  const valid = list.filter((c) => typeof c.mainsnak?.datavalue?.value === "string");
  if (valid.length === 0) return null;
  const preferred = valid.find((c) => c.rank === "preferred");
  return (preferred ?? valid[0]).mainsnak.datavalue.value;
}

/**
 * Résout parti (P102), site officiel (P856) et courriel (P968)
 * d'une liste de politiciens.
 * @param {string[]} qids  Q-IDs Wikidata des politiciens
 * @returns {Promise<Map<string, {partyQid, partyLabel, website, email}>>}
 */
export async function resolveParties(qids) {
  const result = new Map();
  const partyQids = new Set();
  const perPolitician = new Map(); // qid → { partyQid, website, email }

  // Phase 1 : claims des politiciens
  for (let i = 0; i < qids.length; i += BATCH) {
    const entities = await wbGetEntities(qids.slice(i, i + BATCH), "claims");
    for (const [qid, entity] of Object.entries(entities)) {
      const partyQid = pickPartyClaim(entity.claims);
      const website = pickStringClaim(entity.claims, "P856");
      const emailRaw = pickStringClaim(entity.claims, "P968");
      const email = emailRaw ? emailRaw.replace(/^mailto:/i, "") : null;
      if (partyQid) partyQids.add(partyQid);
      if (partyQid || website || email) {
        perPolitician.set(qid, { partyQid, website, email });
      }
    }
  }

  // Phase 2 : libellés français des partis
  const labels = new Map();
  const partyList = [...partyQids];
  for (let i = 0; i < partyList.length; i += BATCH) {
    const entities = await wbGetEntities(partyList.slice(i, i + BATCH), "labels");
    for (const [qid, entity] of Object.entries(entities)) {
      const label = entity.labels?.fr?.value;
      if (label) labels.set(qid, label);
    }
  }

  for (const [polQid, info] of perPolitician) {
    result.set(polQid, {
      partyQid: info.partyQid,
      partyLabel: info.partyQid ? (labels.get(info.partyQid) ?? info.partyQid) : null,
      website: info.website,
      email: info.email,
    });
  }
  return result;
}
