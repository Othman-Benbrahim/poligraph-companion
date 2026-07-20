/**
 * Autodécouverte de flux RSS/Atom sur le site personnel d'un élu.
 * Best-effort assumé : beaucoup de sites d'élus n'ont pas de flux.
 *
 * IMPORTANT : la permission d'hôte pour le site est demandée par le
 * popup (geste utilisateur, permissions.request) AVANT tout appel ici.
 * Sans elle, le fetch échoue proprement (CORS) et on retourne null.
 */

const LINK_TAG = /<link\b[^>]*>/gi;
const FEED_TYPE = /application\/(rss|atom)\+xml/i;
const COMMON_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/?feed=rss2"];

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3] ?? "") : "";
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return null;
    return { text: await res.text(), finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<string|null>} URL du flux, ou null. */
export async function discoverFeed(siteUrl) {
  const page = await fetchText(siteUrl);

  /* 1. Balises <link rel="alternate" type="application/rss+xml"> */
  if (page) {
    for (const m of page.text.matchAll(LINK_TAG)) {
      const tag = m[0];
      if (!/rel\s*=\s*["']?[^"'>]*alternate/i.test(tag)) continue;
      if (!FEED_TYPE.test(attr(tag, "type"))) continue;
      const href = attr(tag, "href");
      if (!href) continue;
      try { return new URL(href, page.finalUrl).href; } catch { /* href invalide */ }
    }
  }

  /* 2. Chemins conventionnels, validés par sniffing du contenu. */
  for (const path of COMMON_PATHS) {
    let candidate;
    try { candidate = new URL(path, siteUrl).href; } catch { continue; }
    const res = await fetchText(candidate);
    if (res && /<(rss|feed)[\s>]/i.test(res.text.slice(0, 2000))) return res.finalUrl;
  }

  return null;
}
