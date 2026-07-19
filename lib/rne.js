/**
 * RNE — Répertoire National des Élus (ministère de l'Intérieur).
 * Fichier « 10 - les maires » (~35 000 lignes, trimestriel, licence ouverte).
 * URL stable data.gouv.fr (redirige vers la dernière version du fichier).
 * Dates au format ISO 8601 depuis la mise à jour post-municipales 2026.
 */

import { parseCSV } from "./csv.js";

export const RNE_MAIRES_URL =
  "https://www.data.gouv.fr/api/1/datasets/r/2876a346-d50c-4911-934e-19ee07b0e503";

/** Les fichiers RNE ont alterné tabulation et point-virgule : on détecte. */
function detectDelimiter(text) {
  const firstLine = text.slice(0, text.indexOf("\n"));
  const counts = { "\t": 0, ";": 0, ",": 0 };
  for (const c of firstLine) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Trouve une colonne par candidats de libellés (insensible casse/accents). */
function pickCol(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const k = keys.find((key) =>
      key.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .includes(cand)
    );
    if (k && row[k]) return row[k].trim();
  }
  return "";
}

function fold(s) {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export async function fetchMairesRNE() {
  const res = await fetch(RNE_MAIRES_URL, { headers: { Accept: "text/csv" } });
  if (!res.ok) throw new Error(`RNE HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text, { delimiter: detectDelimiter(text) });

  return rows.map((r) => {
    const deptCode = pickCol(r, ["code du departement"]);
    let communeCode = pickCol(r, ["code de la commune"]);
    // Code INSEE complet = 5 caractères ; certains millésimes ne stockent
    // que la partie communale → reconstruction avec le département.
    if (communeCode && communeCode.length < 5 && deptCode) {
      communeCode = deptCode.padStart(2, "0") + communeCode.padStart(3, "0");
    }
    const nom = pickCol(r, ["nom de l'elu", "nom de l elu", "nom"]);
    const prenom = pickCol(r, ["prenom de l'elu", "prenom de l elu", "prenom"]);
    return {
      _key: `${communeCode}|${fold(nom)}|${fold(prenom)}`,
      _source: "rne",
      nom, prenom,
      fullName: [prenom, nom].filter(Boolean).join(" "),
      sexe: pickCol(r, ["code sexe"]),
      birthDate: pickCol(r, ["date de naissance"]),
      profession: pickCol(r, ["libelle de la categorie socio"]),
      commune: pickCol(r, ["libelle de la commune"]),
      communeInsee: communeCode,
      departement: pickCol(r, ["libelle du departement"]),
      departementCode: deptCode,
      mandateStart: pickCol(r, ["date de debut du mandat"]),
      fonctionStart: pickCol(r, ["date de debut de la fonction"]),
    };
  }).filter((m) => m.nom && m.communeInsee);
}
