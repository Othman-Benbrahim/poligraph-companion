/**
 * Catalogue de tools exposé au LLM — le pont entre l'assistant et les
 * données. Chaque tool s'appuie sur le cache local (fonctionne hors
 * ligne) ; seuls les votes passent par l'API, avec repli sur le cache.
 */

import {
  searchPolitiques, affairesFor, factchecksFor,
  setCachedVotes, getCachedVotes, getMeta,
} from "./cache.js";
import { fetchVotesJSON, canonicalUrl } from "./api.js";

export const TOOL_DEFS = [
  {
    name: "chercher_politicien",
    description: "Recherche des politiciens français par nom (partiel accepté). Retourne identité, parti, mandat, nombre d'affaires et de fact-checks, et le poligraphId à utiliser pour les autres outils.",
    parameters: {
      type: "object",
      properties: { nom: { type: "string", description: "Nom ou partie du nom" } },
      required: ["nom"],
    },
  },
  {
    name: "affaires_politicien",
    description: "Liste les affaires judiciaires documentées d'un politicien : titre, statut judiciaire précis, gravité, rôle de la personne (mis en cause, victime, mentionné...), dates, nombre de sources, URL de citation.",
    parameters: {
      type: "object",
      properties: { poligraphId: { type: "string", description: "poligraphId du politicien (PG-...)" } },
      required: ["poligraphId"],
    },
  },
  {
    name: "factchecks_politicien",
    description: "Liste les fact-checks liés à un politicien : déclaration vérifiée, verdict, si la personne est l'auteur de la déclaration ou seulement mentionnée, fact-checker, date, URL.",
    parameters: {
      type: "object",
      properties: { poligraphId: { type: "string", description: "poligraphId du politicien (PG-...)" } },
      required: ["poligraphId"],
    },
  },
  {
    name: "votes_politicien",
    description: "Votes parlementaires récents d'un député ou sénateur (position par scrutin) et statistiques de participation. Nécessite le slug du politicien (fourni par chercher_politicien).",
    parameters: {
      type: "object",
      properties: { slug: { type: "string", description: "Slug du politicien" } },
      required: ["slug"],
    },
  },
  {
    name: "etat_donnees",
    description: "Date de dernière mise à jour des données locales. À utiliser si l'utilisateur demande la fraîcheur des informations.",
    parameters: { type: "object", properties: {} },
  },
];

/** Exécute un tool et retourne une chaîne JSON (le contenu du tool_result). */
export async function execTool(name, args) {
  try {
    switch (name) {
      case "chercher_politicien": {
        const rows = await searchPolitiques(args.nom ?? "", 8);
        return JSON.stringify(rows.map((p) => ({
          poligraphId: p.poligraphId,
          slug: p.slug,
          nom: p._displayName,
          parti: p.party || p.wikidataParty || null,
          partiSource: p.party ? "Poligraph" : (p.wikidataParty ? "Wikidata" : null),
          position: p.position || null,
          mandat: p.mandateTitle || p.mandate || null,
          departement: p.department || null,
          decede: p.deathDate || null,
          nbAffaires: p.affairsCount,
          nbFactchecks: p.factchecksCount,
          fiche: p.profileUrl || canonicalUrl(p.poligraphId),
        })));
      }
      case "affaires_politicien": {
        const rows = await affairesFor(args.poligraphId);
        return JSON.stringify(rows.map((a) => ({
          titre: a.title,
          statut: a.status,
          statutCode: a.statusCode,
          gravite: a.severity || null,
          role: a.involvement || "Mis en cause",
          roleCode: a.involvementCode || "DIRECT",
          partiAuMomentDesFaits: a.partyAtTime || null,
          dateFaits: a.factsDate || null,
          dateVerdict: a.verdictDate || null,
          nbSources: a.sourceCount,
          citation: a.pageUrl || canonicalUrl(a.poligraphId),
        })));
      }
      case "factchecks_politicien": {
        const rows = await factchecksFor(args.poligraphId);
        return JSON.stringify(rows.map((f) => ({
          declaration: f.title,
          verdict: f.verdict,
          verdictCode: f.verdictCode,
          role: f.authorDirect ? "auteur de la déclaration" : "mentionné dans le texte",
          factChecker: f.factChecker || null,
          date: f.date || null,
          source: f.url || f.pageUrl || null,
        })));
      }
      case "votes_politicien": {
        let payload, fromCache = false;
        try {
          payload = await fetchVotesJSON(args.slug, { limit: 20 });
          await setCachedVotes(args.slug, payload);
        } catch {
          const cached = await getCachedVotes(args.slug);
          if (!cached) return JSON.stringify({ erreur: "Votes indisponibles (API injoignable, aucun cache)." });
          payload = cached.payload; fromCache = true;
        }
        return JSON.stringify({
          stats: payload.stats ?? null,
          votes: (payload.votes ?? []).map((v) => ({
            scrutin: v.scrutin?.title,
            position: v.position,
            date: v.scrutin?.votingDate,
            resultat: v.scrutin?.result,
            source: v.scrutin?.sourceUrl,
          })),
          donneesEnCache: fromCache,
        });
      }
      case "etat_donnees": {
        const last = await getMeta("lastRefresh");
        return JSON.stringify({
          derniereMiseAJour: last ? new Date(last).toISOString() : null,
          note: last === 0 ? "snapshot embarqué, âge inconnu" : null,
        });
      }
      default:
        return JSON.stringify({ erreur: `Outil inconnu : ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ erreur: err.message });
  }
}
