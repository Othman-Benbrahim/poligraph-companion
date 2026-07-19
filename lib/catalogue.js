/**
 * Délibérations & actes administratifs — catalogue data.gouv.fr.
 * Mode « opportuniste et honnête » : on cherche les jeux de données
 * publiés pour une commune et on affiche des LIENS, sans jamais
 * prétendre parser leur contenu. L'absence de résultat est une
 * information en soi : peu de communes publient.
 *
 * Précision : la recherche est d'abord GÉOGRAPHIQUE (paramètre
 * geozone=fr:commune:INSEE), qui restreint aux jeux officiellement
 * rattachés à la commune — la recherche plein-texte seule renvoie
 * les délibérations de n'importe quelle commune homonyme ou, pire,
 * des résultats sans rapport.
 */

const SEARCH = "https://www.data.gouv.fr/api/2/datasets/search/";

/* Un jeu « délibérations » doit ressembler à un jeu de délibérations. */
const RELEVANT = /d[ée]lib[ée]ration|acte|conseil municipal|d[ée]cision|arr[êe]t[ée]|s[ée]ance/i;

function fold(s) {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function searchDatasets(q, { geozone = null, pageSize = 6 } = {}) {
  const params = new URLSearchParams({ q, page_size: String(pageSize) });
  if (geozone) params.set("geozone", geozone);
  const res = await fetch(`${SEARCH}?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`data.gouv HTTP ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((d) => ({
    title: d.title,
    url: d.page,
    org: d.organization?.name ?? null,
  })).filter((d) => d.title && d.url);
}

/**
 * Jeux de données « délibérations / actes » d'une commune.
 * 1. Recherche géolocalisée par code INSEE (fiable) ;
 * 2. repli plein-texte STRICT : le titre ou l'organisation doit
 *    mentionner la commune, et le titre doit être pertinent.
 * Dédupliqué par URL et par titre normalisé, 4 résultats max.
 */
export async function searchDeliberations(communeName, codeInsee) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const out = [];
  const communeFolded = fold(communeName);

  const push = (r) => {
    const t = fold(r.title);
    if (seenUrl.has(r.url) || seenTitle.has(t)) return;
    if (!RELEVANT.test(r.title)) return; // écarte les « GR 653 » du monde
    seenUrl.add(r.url); seenTitle.add(t);
    out.push(r);
  };

  /* 1. Géolocalisé : les jeux rattachés à la commune. */
  if (codeInsee) {
    for (const q of ["délibérations", "actes", "conseil municipal"]) {
      if (out.length >= 4) break;
      try {
        for (const r of await searchDatasets(q, { geozone: `fr:commune:${codeInsee}` })) {
          if (out.length >= 4) break;
          push(r);
        }
      } catch { /* requête suivante */ }
    }
  }

  /* 2. Repli plein-texte strict (jeux mal géo-taggés). */
  if (out.length === 0 && communeFolded) {
    try {
      for (const r of await searchDatasets(`délibérations ${communeName}`)) {
        if (out.length >= 4) break;
        const hay = fold(`${r.title} ${r.org ?? ""}`);
        if (hay.includes(communeFolded)) push(r);
      }
    } catch { /* tant pis */ }
  }

  return out;
}
