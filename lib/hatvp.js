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
        enCoursDePublication: !r.nom_fichier, // notice : fichier vide = pas encore publiée
      };
    });
}
