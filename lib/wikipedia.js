/**
 * Résumé biographique — Wikipédia (contenu contributif, à étiqueter).
 * Jointure sans ambiguïté : Q-ID Wikidata → sitelink frwiki → API REST
 * summary (paragraphe d'introduction de l'article).
 */

const WD_API = "https://www.wikidata.org/w/api.php";
const WP_SUMMARY = "https://fr.wikipedia.org/api/rest_v1/page/summary/";

/** Titre de l'article Wikipédia FR d'une entité Wikidata (ou null). */
async function frwikiTitle(qid) {
  const params = new URLSearchParams({
    action: "wbgetentities", ids: qid,
    props: "sitelinks", sitefilter: "frwiki",
    format: "json", origin: "*",
  });
  const res = await fetch(`${WD_API}?${params}`);
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const data = await res.json();
  return data.entities?.[qid]?.sitelinks?.frwiki?.title ?? null;
}

/** Coupe proprement à la fin d'une phrase, autour de maxChars. */
function truncateAtSentence(text, maxChars = 420) {
  if (!text || text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\u00a0"));
  return lastStop > 120 ? slice.slice(0, lastStop + 1) : slice + "…";
}

/**
 * Résumé biographique d'un politicien.
 * @returns {Promise<{extract, title, url}|null>}
 */
export async function getBioForQid(qid) {
  const title = await frwikiTitle(qid);
  if (!title) return null;
  const res = await fetch(WP_SUMMARY + encodeURIComponent(title.replace(/ /g, "_")));
  if (!res.ok) throw new Error(`Wikipédia HTTP ${res.status}`);
  const data = await res.json();
  if (!data.extract) return null;
  return {
    extract: truncateAtSentence(data.extract),
    title: data.title ?? title,
    url: data.content_urls?.desktop?.page ?? `https://fr.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}
