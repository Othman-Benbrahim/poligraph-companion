/**
 * Flux RSS Poligraph — suivi d'élus.
 * Parsing volontairement minimal par expressions régulières : DOMParser
 * n'existe pas dans un service worker Chrome, et les flux Poligraph
 * sont réguliers. On n'extrait que titre, lien, description, date.
 */

const FEEDS = [
  { id: "affaires", url: "https://poligraph.fr/api/rss/affaires.xml", label: "Affaire" },
  { id: "factchecks", url: "https://poligraph.fr/api/rss/factchecks.xml", label: "Fact-check" },
];

function unescapeXml(s) {
  return (s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "") // balises HTML résiduelles des descriptions
    .trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unescapeXml(m[1]) : "";
}

/** Récupère et parse tous les flux. Un flux en panne n'annule pas les autres. */
export async function fetchFeeds() {
  const items = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { Accept: "application/rss+xml, application/xml" } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const raw = m[1];
        const link = tag(raw, "link");
        if (!link) continue;
        items.push({
          feed: feed.id,
          feedLabel: feed.label,
          title: tag(raw, "title"),
          description: tag(raw, "description").slice(0, 300),
          link,
          date: tag(raw, "pubDate"),
        });
      }
    } catch { /* flux suivant */ }
  }
  return items;
}
