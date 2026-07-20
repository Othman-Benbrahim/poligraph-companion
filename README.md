# Poligraph Companion

Extension navigateur (Firefox, portable Chrome) : le portail citoyen sur les
politiques français. Recherche instantanée, fiches complètes (biographie,
mandat, contact institutionnel, activité parlementaire, affaires judiciaires,
fact-checks, votes, déclarations HATVP), détection des élus sur les pages
web (tooltips, opt-in), suivi d'élus par flux RSS (badge), comparateur,
fonctionnement hors ligne, et
assistant IA optionnel en BYOK.

**Version : 0.7.4** — développée en juillet 2026.

## Sources de données (8)

| Source | Contenu | Cadence | Licence |
|---|---|---|---|
| [Poligraph](https://poligraph.fr) | Politiciens, affaires judiciaires, fact-checks, votes | quotidienne (exports CSV) + votes à la demande | réutilisation avec citation |
| [Wikidata](https://www.wikidata.org) | Parti (P102), site officiel (P856), courriel (P968) | après chaque refresh, par lots de 50 | CC0 |
| [Wikipédia FR](https://fr.wikipedia.org) | Résumé biographique (via Q-ID, zéro homonymie) | à la demande, cache 30 j | CC BY-SA (contenu contributif, étiqueté) |
| RNE ([data.gouv.fr](https://www.data.gouv.fr/datasets/repertoire-national-des-elus-1)) | ~35 000 maires (fichier ministère de l'Intérieur) | hebdomadaire | licence ouverte |
| [Annuaire DILA](https://api-lannuaire.service-public.fr) | Contact mairies (par code INSEE) et ministères | à la demande, cache (échecs 24 h) | licence ouverte |
| [Datan](https://www.data.gouv.fr/organizations/datan/) | Députés 17e lég. : courriel, site, scores d'activité | hebdomadaire | licence ouverte |
| NosSénateurs.fr | Sénateurs : courriel institutionnel (best-effort) | hebdomadaire | ODbL |
| [HATVP](https://www.hatvp.fr/open-data/) | Index des déclarations publiées (liste.csv) | hebdomadaire | licence ouverte Etalab |

Catalogue data.gouv.fr en bonus : liens vers les délibérations/actes publiés
en open data par les communes (recherche géolocalisée par `geozone`).

⚠ **NosDéputés.fr est figé depuis la dissolution de juin 2024** (`enmandat`
vide) — remplacé par Datan pour les députés. Leçon : chaque source échoue
indépendamment, le rapport ⟳ du popup affiche l'état de chacune.

**Identification du trafic** : à la demande du créateur de Poligraph, les
requêtes de l'extension vers poligraph.fr (et uniquement celles-là)
s'identifient par l'en-tête `User-Agent: PoligraphCompanion/<version>`.
Aucune donnée utilisateur n'est transmise — juste le nom de l'extension,
pour qu'il puisse repérer et accompagner ce trafic dans ses logs. La
navigation manuelle de l'utilisateur sur le site n'est jamais marquée.

## Architecture

```
manifest.json            MV3, clés dual Firefox/Chrome, permissions par hôte
background/background.js Alarmes de rafraîchissement + menu contextuel
                         + rapport par source (permissions vérifiées)
popup/                   Recherche unifiée (Poligraph + maires RNE, par nom
                         OU par commune) + fiche multi-sections
options/                 Configuration BYOK de l'assistant (14 presets)
chat/                    Assistant IA (page dédiée, tool calling)
lib/api.js               Client API Poligraph (= catalogue de tools de l'IA)
lib/cache.js             IndexedDB (6 stores) + orchestration des sources
lib/csv.js               Parseur CSV (BOM, guillemets, délimiteur variable)
lib/wikidata.js          Enrichissement P102/P856/P968 par lots
lib/wikipedia.js         Résumé biographique via sitelink frwiki
lib/rne.js               Fichier maires (détection de délimiteur, INSEE)
lib/annuaire.js          DILA (requêtes en cascade, tolérantes aux 400)
lib/parlement.js         Datan (CSV) + NosSénateurs (JSON, best-effort)
lib/hatvp.js             Index des déclarations (libellés officiels)
lib/catalogue.js         Délibérations (geozone + filtre de pertinence)
lib/llm.js               Client LLM unifié (Anthropic natif + OpenAI-compat)
lib/tools.js             5 tools exposés au LLM (cache-first, hors ligne)
lib/agent.js             Boucle agentique + prompt système éditorial
data/snapshot-*.json     Snapshot embarqué au build (fallback niveau 3)
```

### Fallback à 3 niveaux

1. **APIs en direct** — fraîcheur (votes, contacts mairie, bio).
2. **Cache IndexedDB** — toute l'UI lit le cache : recherche instantanée,
   hors ligne, zéro charge serveur au fil de la frappe. Bandeau d'âge des
   données si une source est injoignable.
3. **Snapshot embarqué** — `data/snapshot-politiques.json` (à générer au
   build, voir ci-dessous) pour une première installation hors ligne.

### Assistant IA (BYOK)

L'utilisateur fournit sa clé (jamais synchronisée) ou un modèle local :
Anthropic en protocole natif ; OpenRouter, OpenAI, Gemini, Groq, Mistral,
DeepSeek, xAI, Together, Fireworks, Perplexity en compatible OpenAI ;
Ollama et LM Studio en local sans clé. Tool calling sur le cache local
(fonctionne hors ligne), permissions d'hôte demandées à l'enregistrement.
Pour Ollama sous Firefox : `OLLAMA_ORIGINS=moz-extension://* ollama serve`.

## Ligne éditoriale (le plus important)

- **Présomption d'innocence** : le statut judiciaire exact de chaque affaire
  est toujours affiché (timbres colorés par état de la procédure, jamais par
  jugement moral) ; condamnation définitive ≠ instruction ≠ relaxe.
- **Rôle dans l'affaire** : mis en cause ≠ victime ≠ mentionné (double timbre).
- **Parti au moment des faits** affiché quand il diffère du parti actuel.
- **Absence ≠ probité** : tout état vide rappelle que l'absence d'information
  ne préjuge pas de la réalité. La section HATVP n'apparaît que si des
  déclarations existent (la plupart des élus ne sont pas assujettis).
- **Provenance visible** partout : chaque donnée affiche sa source ; les
  données déclaratives (HATVP) et contributives (Wikipédia) sont étiquetées.
- **Coordonnées institutionnelles uniquement** : courriels officiels
  (@assemblee-nationale.fr, @senat.fr, mairies, ministères), jamais des
  adresses personnelles ; âge plutôt que date de naissance pour les élus
  locaux ; scores d'activité présentés comme descriptifs, pas comme des notes.
- L'assistant IA répond exclusivement depuis les données des tools, cite
  ses sources, et décline les demandes d'opinion.

## Tester sous Firefox

1. `about:debugging` → « Ce Firefox » → « Charger un module complémentaire
   temporaire » → sélectionner `manifest.json`.
2. **Permissions** : `about:addons` → Poligraph Companion → onglet
   Permissions → activer l'accès à tous les hôtes (Firefox MV3 ne les
   accorde pas automatiquement).
3. Cliquer ⟳ dans le popup et lire le rapport par source.
4. Le numéro de version s'affiche en bas du popup.

## Portage Chrome

Anticipé dès l'origine, non testé : clés `background` duales
(`scripts`/`service_worker`), shim `browser`/`chrome`, aucun état global
dans le background (tout passe par storage/IndexedDB),
`browser_specific_settings` ignoré par Chrome (warning bénin).

## Générer le snapshot embarqué

```bash
curl -s "https://poligraph.fr/api/export/politiques" \
  | python3 -c "import sys,csv,json; print(json.dumps(list(csv.DictReader(sys.stdin))))" \
  > data/snapshot-politiques.json
```

## Pistes non réalisées

- ~~Résumé des rubriques XML HATVP~~ — réalisé en v0.7.1 (structure validée
  par le code communautaire mdamien/hatvp ; résumé sans montants, tiers
  en comptage seul, patrimoine exclu).
- Portage Chrome effectif ; page d'options générales.
- ~~Détection des noms, suivi RSS, comparateur~~ — réalisés en v0.7.0.

- Nuances politiques des municipales (communes ≥ 9 000 hab.) en complément
  de Wikidata ; équivalent Datan côté Sénat.
- Serveur MCP officiel Poligraph (`ironlam/poligraph-mcp`) comme
  alternative au catalogue de tools local.
- Contacter l'équipe Poligraph (rate limit constaté : 60 req/fenêtre —
  l'architecture cache-first le respecte largement).

## Mentions

Données : Poligraph (observatoire civique), Wikidata, Wikipédia, ministère
de l'Intérieur (RNE), DILA, Datan, Regards Citoyens, HATVP — chacune sous
sa licence propre, citée dans l'interface. La présomption d'innocence
s'applique à toute personne visée par une procédure en cours ; l'absence
d'information ne préjuge pas de la réalité.
