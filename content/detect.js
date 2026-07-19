/**
 * Détection des noms de politiciens sur les pages web (opt-in).
 * Désactivée par défaut — activable depuis le popup. Un seul passage
 * au chargement (pas de MutationObserver : sobriété avant tout).
 *
 * Principe : on repère les séquences de mots capitalisés candidates,
 * puis on les confronte à l'index des profils Poligraph fourni par le
 * background. Aucune donnée de la page n'est envoyée où que ce soit :
 * l'index descend, rien ne remonte.
 */
(async () => {
  const b = globalThis.browser ?? globalThis.chrome;

  const { detectEnabled } = await b.storage.local.get("detectEnabled");
  if (!detectEnabled) return;
  if (document.contentType && !document.contentType.includes("html")) return;

  const resp = await b.runtime.sendMessage({ type: "get-name-index" }).catch(() => null);
  const index = resp?.index;
  if (!index || Object.keys(index).length === 0) return;

  const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  /* Candidats : 2 à 4 mots capitalisés, particules autorisées. */
  const CANDIDATE = /\p{Lu}[\p{L}'’-]+(?:[ \u00a0](?:(?:de|du|des|d'|d’|le|la|van|von)[ \u00a0])?\p{Lu}[\p{L}'’-]+){1,3}/gu;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "CODE", "PRE", "MARK", "A"]);
  const MAX_NODES = 15000;
  const MAX_MARKS = 200;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (p.closest("[contenteditable], .plg-mark")) return NodeFilter.FILTER_REJECT;
      return node.textContent.length > 6 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  let count = 0;
  while (walker.nextNode() && count++ < MAX_NODES) nodes.push(walker.currentNode);

  let marks = 0;
  for (const node of nodes) {
    if (marks >= MAX_MARKS) break;
    const text = node.textContent;
    CANDIDATE.lastIndex = 0;
    let m, found = null;
    const hits = [];
    while ((m = CANDIDATE.exec(text)) !== null) {
      const key = fold(m[0].replace(/\u00a0/g, " "));
      if (index[key]) hits.push({ start: m.index, end: m.index + m[0].length, key });
    }
    if (hits.length === 0) continue;

    /* Remplacement du nœud texte par une suite texte/mark. */
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const hit of hits) {
      if (marks >= MAX_MARKS) break;
      frag.append(document.createTextNode(text.slice(cursor, hit.start)));
      const mark = document.createElement("mark");
      mark.className = "plg-mark";
      mark.textContent = text.slice(hit.start, hit.end);
      mark.dataset.plgKey = hit.key;
      frag.append(mark);
      cursor = hit.end;
      marks++;
    }
    frag.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(frag);
  }
  if (marks === 0) return;

  /* ------------------------- tooltip unique ------------------------ */
  const tip = document.createElement("div");
  tip.className = "plg-tooltip";
  tip.hidden = true;
  document.body.append(tip);
  let hideTimer;

  function showTip(mark) {
    clearTimeout(hideTimer);
    const info = index[mark.dataset.plgKey];
    if (!info) return;
    tip.replaceChildren();

    const name = document.createElement("div");
    name.className = "plg-name";
    name.textContent = info.n;
    const meta = document.createElement("div");
    meta.className = "plg-meta";
    meta.textContent = [info.p, info.m].filter(Boolean).join(" · ") || "Profil Poligraph";
    tip.append(name, meta);

    if (info.a > 0 || info.f > 0) {
      const counts = document.createElement("div");
      counts.className = "plg-counts";
      const bits = [];
      if (info.a > 0) bits.push(`${info.a} affaire${info.a > 1 ? "s" : ""} documentée${info.a > 1 ? "s" : ""}`);
      if (info.f > 0) bits.push(`${info.f} fact-check${info.f > 1 ? "s" : ""}`);
      counts.textContent = bits.join(" · ");
      tip.append(counts);
      const legal = document.createElement("div");
      legal.className = "plg-legal";
      legal.textContent = "Statuts judiciaires détaillés sur la fiche — présomption d'innocence.";
      tip.append(legal);
    }

    const link = document.createElement("a");
    link.href = info.u;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Voir la fiche Poligraph ↗";
    tip.append(link);

    const r = mark.getBoundingClientRect();
    tip.hidden = false;
    const top = r.bottom + window.scrollY + 6;
    let left = r.left + window.scrollX;
    tip.style.top = `${top}px`;
    tip.style.left = "0px";
    const tw = tip.getBoundingClientRect().width;
    if (left + tw > window.scrollX + document.documentElement.clientWidth - 8) {
      left = Math.max(8, window.scrollX + document.documentElement.clientWidth - tw - 8);
    }
    tip.style.left = `${left}px`;
  }

  function scheduleHide() {
    hideTimer = setTimeout(() => { tip.hidden = true; }, 250);
  }

  document.addEventListener("mouseover", (e) => {
    const mark = e.target.closest?.(".plg-mark");
    if (mark) showTip(mark);
    else if (!e.target.closest?.(".plg-tooltip")) scheduleHide();
  });
  tip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  tip.addEventListener("mouseleave", scheduleHide);
})();
