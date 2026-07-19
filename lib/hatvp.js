/**
 * HATVP — Haute Autorité pour la transparence de la vie publique.
 * Index des déclarations PUBLIÉES (liste.csv officiel, licence ouverte,
 * séparateur « ; », UTF-8). Une ligne par document publié.
 *
 * EXIGENCE ÉDITORIALE MAXIMALE : ce sont des données DÉCLARATIVES,
 * remises par les élus eux-mêmes. On les présente sans insinuation :
 * type de document, date, qualité du déclarant, lien vers le dossier
 * officiel. Rien de plus. L'appariement se fait par nom : la qualité
 * affichée sert de garde-fou contre les homonymes.
 *
 * URL vérifiée sur https://www.hatvp.fr/open-data/ (la notice PDF
 * indique un ancien chemin /files/open-data/ qui renvoie 404).
 */

import { parseCSV } from "./csv.js";

export const HATVP_LISTE_URL = "https://www.hatvp.fr/livraison/opendata/liste.csv";
const SITE = "https://www.hatvp.fr";

export const DOC_LABELS = {
  dia: "Déclaration d'intérêts et d'activités",
  diam: "Modification des intérêts et activités",
  di: "Déclaration d'intérêts",
  dim: "Modification des intérêts",
  dsp: "Déclaration de situation patrimoniale",
  dspm: "Modification de situation patrimoniale",
  appreciation: "Appréciation de la HATVP",
};

export const MANDAT_LABELS = {
  senateur: "Sénat",
  depute: "Assemblée nationale",
  gouvernement: "Gouvernement",
  europe: "Parlement européen",
  region: "Conseil régional",
  departement: "Conseil départemental",
  commune: "Conseil municipal",
  epci: "Intercommunalité",
};

function fold(s) {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Dates AAAA-MM-JJ (notice actuelle) ou JJ/MM/AAAA (historique) → ISO. */
function toIso(d) {
  if (!d) return "";
  const fr = d.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return fr ? `${fr[3]}-${fr[2]}-${fr[1]}` : d.slice(0, 10);
}

export async function fetchHatvpIndex() {
  const res = await fetch(HATVP_LISTE_URL, { headers: { Accept: "text/csv" } });
  if (!res.ok) throw new Error(`HATVP HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text, { delimiter: ";" });

  return rows
    .filter((r) => r.nom && r.prenom)
    .map((r, i) => {
      const fullName = `${r.prenom} ${r.nom}`.trim();
      const datePublication = toIso(r.date_publication);
      return {
        _key: `${fold(fullName)}|${r.type_document}|${datePublication}|${r.nom_fichier || i}`,
        foldedName: fold(fullName),
        fullName,
        civilite: r.civilite || "",
        typeMandat: r.type_mandat || "",
        mandatLabel: MANDAT_LABELS[r.type_mandat] ?? r.type_mandat ?? "",
        qualite: r.qualite || "",
        typeDocument: r.type_document || "",
        docLabel: DOC_LABELS[r.type_document] ?? r.type_document ?? "Document",
        departement: r.departement || "",
        datePublication,
        dateDepot: toIso(r.date_depot),
        urlDossier: r.url_dossier ? SITE + r.url_dossier : SITE + "/consulter-les-declarations/",
        nomFichier: r.nom_fichier || "",
        enCoursDePublication: !r.nom_fichier, // notice : fichier vide = pas encore publiée
      };
    });
}

/* ================== résumé des rubriques (XML) ===================== */
/*
 * Structure VALIDÉE par du code communautaire en production
 * (github.com/mdamien/hatvp, qui parse le declarations.xml officiel) :
 *   <declaration>
 *     <general><declarant><nom/><prenom/></declarant>…</general>
 *     <participationFinanciereDto><neant>true|false</neant>
 *       <items><items>…<nomSociete/>…</items><items>…</items></items>
 *     </participationFinanciereDto>
 *     … idem pour chaque rubrique *Dto …
 *   </declaration>
 * Placeholders rencontrés dans les données : "[Données non publiées]", "-".
 */

/** Rubriques résumées, avec ligne éditoriale par rubrique :
 *  - labels: champs candidats pour nommer un item (premier non vide) ;
 *  - countOnly: true → comptage seul, JAMAIS de détails (tiers :
 *    conjoint, collaborateurs — leurs informations ne concernent pas
 *    directement l'élu·e et restent à un clic sur le dossier officiel). */
const RUBRIQUES = [
  { tag: "participationFinanciereDto", label: "Participations financières", labels: ["nomSociete"] },
  { tag: "participationDirigeantDto", label: "Fonctions de dirigeant", labels: ["nomSociete", "description"] },
  { tag: "activProfCinqDerniereDto", label: "Activités professionnelles (5 dernières années)", labels: ["employeur", "nomEmployeur", "description"] },
  { tag: "activConsultantDto", label: "Activités de consultant", labels: ["nomEmployeur", "description"] },
  { tag: "fonctionBenevoleDto", label: "Fonctions bénévoles", labels: ["nomStructure", "description", "nom"] },
  { tag: "mandatElectifDto", label: "Autres mandats électifs", labels: ["description", "mandat"] },
  { tag: "activProfConjointDto", label: "Activités du conjoint", countOnly: true },
  { tag: "activCollaborateursDto", label: "Activités des collaborateurs", countOnly: true },
];

const PLACEHOLDER = /^\s*(\[données non publiées\]|-|—)?\s*$/i;

function textOf(el, tag) {
  const child = el?.querySelector(`:scope > ${tag}`);
  return child?.textContent?.trim() ?? "";
}

/**
 * Tente de télécharger le XML d'une déclaration. Le chemin des dossiers
 * a varié selon les millésimes : deux candidats, échec silencieux.
 */
export async function fetchDeclarationXml(nomFichier) {
  if (!nomFichier) return null;
  const file = nomFichier.replace(/\.pdf$/i, ".xml"); // certains millésimes listent le PDF
  const candidates = [
    `${SITE}/livraison/dossiers/${encodeURIComponent(file)}`,
    `${SITE}/files/declarations/${encodeURIComponent(file)}`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/xml, text/xml" } });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes("<declaration")) return text;
    } catch { /* candidat suivant */ }
  }
  return null;
}

/**
 * Résumé d'une déclaration : par rubrique déclarée non vide, un
 * comptage et jusqu'à 3 intitulés. AUCUN montant n'est extrait —
 * les montants et le détail restent sur le dossier officiel, où
 * ils sont présentés dans leur contexte complet.
 * NB : utilise DOMParser — à appeler depuis une page d'extension
 * (popup), jamais depuis le service worker.
 */
export function parseDeclarationSummary(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) return null;

  const out = [];
  for (const rub of RUBRIQUES) {
    const node = doc.querySelector(rub.tag);
    if (!node) continue;
    if (textOf(node, "neant") === "true") continue;
    const items = node.querySelectorAll(":scope > items > items");
    if (items.length === 0) continue;

    const entry = { label: rub.label, count: items.length, names: [] };
    if (!rub.countOnly) {
      for (const item of items) {
        if (entry.names.length >= 3) break;
        for (const field of rub.labels) {
          const v = textOf(item, field);
          if (v && !PLACEHOLDER.test(v)) { entry.names.push(v); break; }
        }
      }
    }
    out.push(entry);
  }
  return out;
}
