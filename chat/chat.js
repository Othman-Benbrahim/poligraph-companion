import "../lib/browser-shim.js";
import { runAgent } from "../lib/agent.js";
import { seedFromSnapshotIfEmpty } from "../lib/cache.js";

const $ = (id) => document.getElementById(id);
const thread = $("thread");
const input = $("input");
const sendBtn = $("send");

let history = [];   // messages unifiés (avec tool calls) pour le contexte LLM
let cfg = null;

const TOOL_LABELS = {
  chercher_politicien: (a) => `Recherche de « ${a.nom} »…`,
  affaires_politicien: () => "Consultation des affaires judiciaires…",
  factchecks_politicien: () => "Consultation des fact-checks…",
  votes_politicien: () => "Récupération des votes parlementaires…",
  etat_donnees: () => "Vérification de la fraîcheur des données…",
};

/* ------------------------------ rendu ------------------------------ */

function addMsg(cls, text) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  if (cls === "assistant") renderWithLinks(div, text);
  else div.textContent = text;
  thread.append(div);
  thread.scrollTop = thread.scrollHeight;
  return div;
}

function addActivity(text) {
  const div = document.createElement("div");
  div.className = "activity";
  div.textContent = text;
  thread.append(div);
  thread.scrollTop = thread.scrollHeight;
  return div;
}

/** Rend le texte avec les URLs http(s) cliquables — sans innerHTML. */
function renderWithLinks(container, text) {
  const parts = text.split(/(https?:\/\/[^\s)\]}>,;«»"']+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement("a");
      a.href = part; a.textContent = part;
      a.target = "_blank"; a.rel = "noopener";
      container.append(a);
    } else {
      container.append(document.createTextNode(part));
    }
  }
}

/* ---------------------------- envoi -------------------------------- */

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question || sendBtn.disabled) return;

  if (!cfg) {
    addMsg("error", "Aucun modèle configuré. Ouvrez les réglages (⚙) pour renseigner votre fournisseur, modèle et clé API.");
    return;
  }

  input.value = "";
  sendBtn.disabled = true;
  addMsg("user", question);
  history.push({ role: "user", content: question });

  const activities = [];
  try {
    const { history: newHistory, text } = await runAgent(cfg, history, (ev) => {
      if (ev.type === "tool") {
        const label = TOOL_LABELS[ev.name]?.(ev.args) ?? `Outil : ${ev.name}…`;
        activities.push(addActivity(label));
      }
    });
    history = newHistory;
    for (const a of activities) a.remove();
    addMsg("assistant", text);
  } catch (err) {
    for (const a of activities) a.remove();
    addMsg("error", `Erreur : ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("btn-settings").addEventListener("click", () => browser.runtime.openOptionsPage());

/* --------------------------- démarrage ----------------------------- */

(async function init() {
  await seedFromSnapshotIfEmpty();
  const { llmConfig } = await browser.storage.local.get("llmConfig");
  cfg = llmConfig ?? null;
  $("model-badge").textContent = cfg ? `${cfg.model}` : "non configuré";
  if (!cfg) {
    addMsg("error", "Assistant non configuré : ouvrez les réglages (⚙) pour choisir un fournisseur (Anthropic, OpenAI-compatible, ou un modèle local Ollama / LM Studio).");
  }
  input.focus();
})();
