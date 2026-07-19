import "../lib/browser-shim.js";
import {
  searchPolitiques, affairesFor, factchecksFor,
  parlementContactFor, seedFromSnapshotIfEmpty,
} from "../lib/cache.js";

/* Regroupement des statuts — identique au popup (jamais un jugement). */
const GROUPS = {
  definitif: ["CONDAMNATION_DEFINITIVE"],
  enCours: ["ENQUETE_PRELIMINAIRE", "INSTRUCTION", "MISE_EN_EXAMEN", "RENVOI_TRIBUNAL",
    "PROCES_EN_COURS", "CONDAMNATION_PREMIERE_INSTANCE", "APPEL_EN_COURS"],
  blanchi: ["RELAXE", "ACQUITTEMENT", "NON_LIEU"],
};

function ventile(affaires) {
  const direct = affaires.filter((a) => !a.involvementCode || a.involvementCode === "DIRECT");
  const v = { definitif: 0, enCours: 0, blanchi: 0, autre: 0 };
  for (const a of direct) {
    if (GROUPS.definitif.includes(a.statusCode)) v.definitif++;
    else if (GROUPS.enCours.includes(a.statusCode)) v.enCours++;
    else if (GROUPS.blanchi.includes(a.statusCode)) v.blanchi++;
    else v.autre++;
  }
  return { ...v, total: direct.length, nonDirect: affaires.length - direct.length };
}

for (const col of document.querySelectorAll(".col")) {
  const input = col.querySelector(".pick");
  const suggest = col.querySelector(".suggest");
  const card = col.querySelector(".card");
  let timer;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const rows = await searchPolitiques(input.value, 6);
      suggest.replaceChildren();
      suggest.hidden = rows.length === 0;
      for (const p of rows) {
        const li = document.createElement("li");
        const name = document.createElement("div");
        name.textContent = p._displayName;
        const meta = document.createElement("div");
        meta.className = "s-meta";
        meta.textContent = [p.party || p.wikidataParty, p.mandate].filter(Boolean).join(" · ");
        li.append(name, meta);
        li.addEventListener("click", () => {
          suggest.hidden = true;
          input.value = p._displayName;
          renderCard(card, p);
        });
        suggest.append(li);
      }
    }, 150);
  });
}

async function renderCard(card, pol) {
  card.hidden = false;
  card.replaceChildren();

  const head = document.createElement("div");
  head.className = "c-head";
  if (pol.photo) {
    const img = document.createElement("img");
    img.src = pol.photo; img.alt = "";
    head.append(img);
  }
  const hwrap = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = pol._displayName;
  const sub = document.createElement("div");
  sub.className = "c-sub";
  sub.textContent = [pol.mandateTitle || pol.mandate, pol.party || pol.wikidataParty,
    pol.department ? `dépt. ${pol.department}` : null].filter(Boolean).join(" · ");
  hwrap.append(h2, sub);
  head.append(hwrap);
  card.append(head);

  const [affaires, fchecks, parl] = await Promise.all([
    affairesFor(pol.poligraphId),
    factchecksFor(pol.poligraphId),
    parlementContactFor(pol._displayName).catch(() => null),
  ]);
  const v = ventile(affaires);

  const dl = document.createElement("dl");
  const row = (k, val, cls) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = val;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  };

  row("Affaires (mis·e en cause)", String(v.total));
  if (v.definitif) row("→ condamnations définitives", String(v.definitif), "n-red");
  if (v.enCours) row("→ procédures en cours", String(v.enCours), "n-amber");
  if (v.blanchi) row("→ relaxes / non-lieux", String(v.blanchi), "n-ok");
  if (v.autre) row("→ autres statuts", String(v.autre));
  if (v.nonDirect) row("Autres rôles (victime, mention…)", String(v.nonDirect));
  row("Fact-checks (mentions)", String(fchecks.length));

  const s = parl?.stats;
  if (s?.type === "scores") {
    if (s.participation !== null) row("Participation aux scrutins", `${s.participation} %`);
    if (s.loyaute !== null) row("Loyauté au groupe", `${s.loyaute} %`);
    if (s.majorite !== null) row("Proximité majorité", `${s.majorite} %`);
    if (s.mandats) row("Mandats de député", String(s.mandats));
  }
  card.append(dl);

  const link = document.createElement("a");
  link.href = pol.profileUrl || `https://poligraph.fr/id/${encodeURIComponent(pol.poligraphId)}`;
  link.target = "_blank"; link.rel = "noopener";
  link.textContent = "Fiche complète sur poligraph.fr ↗";
  card.append(link);
}

seedFromSnapshotIfEmpty();
