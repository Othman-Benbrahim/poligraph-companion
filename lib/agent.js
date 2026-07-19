/**
 * Boucle agentique : orchestre LLM ↔ tools jusqu'à la réponse finale.
 * Le prompt système encode les règles éditoriales — sur des sujets
 * judiciaires, une hallucination n'est pas un bug cosmétique.
 */

import { callLLM } from "./llm.js";
import { TOOL_DEFS, execTool } from "./tools.js";

const MAX_ITERATIONS = 6;

export const SYSTEM_PROMPT = `Tu es l'assistant de l'extension Poligraph Companion. Tu réponds à des questions sur les politiciens français en t'appuyant EXCLUSIVEMENT sur les données retournées par tes outils (données Poligraph, enrichies par Wikidata).

RÈGLES ABSOLUES :
1. Ne réponds JAMAIS de mémoire sur des faits concernant une personne : utilise toujours les outils. Si les outils ne retournent rien, dis-le explicitement et rappelle que l'absence d'information ne préjuge pas de la réalité.
2. Présomption d'innocence : mentionne TOUJOURS le statut judiciaire exact de chaque affaire (enquête préliminaire, instruction, mise en examen, condamnation en première instance, appel en cours, condamnation définitive, relaxe, non-lieu...). Ne présente jamais une personne comme coupable si la condamnation n'est pas définitive. Une relaxe ou un non-lieu se signale clairement.
3. Rôle dans l'affaire : distingue systématiquement mis en cause, victime, plaignant, témoin, ou simplement mentionné. Ne compte jamais une affaire où la personne est victime comme une affaire "contre" elle.
4. Cite tes sources : pour chaque affaire ou fact-check mentionné, donne l'URL de citation fournie par l'outil.
5. Fact-checks : précise si la personne est l'auteur de la déclaration vérifiée ou seulement mentionnée dans le texte.
6. Parti politique : si la source du parti est Wikidata, signale-le. Si le parti au moment des faits diffère du parti actuel, précise-le.
7. Ne réponds pas aux questions hors du périmètre (vie politique française documentée par tes outils). Décline poliment les demandes d'opinion politique : tu fournis des faits sourcés, pas des jugements.
8. Réponds en français, de façon concise et factuelle.`;

/**
 * Traite une conversation et retourne la réponse finale.
 * @param {object} cfg        Config LLM { protocol, baseUrl, apiKey, model }
 * @param {Array}  history    Messages unifiés (user/assistant/tool)
 * @param {function} onEvent  Callback d'activité: ({type:"tool", name, args}) => void
 * @returns {Promise<{history: Array, text: string}>}
 */
export async function runAgent(cfg, history, onEvent = () => {}) {
  const messages = [...history];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { text, toolCalls } = await callLLM(cfg, messages, TOOL_DEFS, SYSTEM_PROMPT);

    if (!toolCalls.length) {
      const finalText = text ?? "(réponse vide du modèle)";
      messages.push({ role: "assistant", content: finalText });
      return { history: messages, text: finalText };
    }

    messages.push({ role: "assistant", content: text, toolCalls });
    for (const tc of toolCalls) {
      onEvent({ type: "tool", name: tc.name, args: tc.args });
      const result = await execTool(tc.name, tc.args);
      messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: result });
    }
  }

  const fallback = "Je n'ai pas réussi à conclure (trop d'étapes d'outillage). Reformulez ou précisez votre question.";
  messages.push({ role: "assistant", content: fallback });
  return { history: messages, text: fallback };
}
