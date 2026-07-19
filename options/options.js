import "../lib/browser-shim.js";
import { PRESETS, callLLM } from "../lib/llm.js";

const $ = (id) => document.getElementById(id);
const presetSel = $("preset");

/* Peupler le sélecteur de presets */
for (const [id, p] of Object.entries(PRESETS)) {
  const opt = document.createElement("option");
  opt.value = id; opt.textContent = p.label;
  presetSel.append(opt);
}

presetSel.addEventListener("change", () => {
  const p = PRESETS[presetSel.value];
  if (presetSel.value !== "custom") $("baseUrl").value = p.baseUrl;
  $("model").placeholder = p.placeholderModel ?? "nom du modèle";
  $("key-optional").hidden = !p.noKey;
});

/* Charger la config existante */
(async () => {
  const { llmConfig } = await browser.storage.local.get("llmConfig");
  if (llmConfig) {
    presetSel.value = llmConfig.preset ?? "custom";
    presetSel.dispatchEvent(new Event("change"));
    $("baseUrl").value = llmConfig.baseUrl ?? "";
    $("model").value = llmConfig.model ?? "";
    $("apiKey").value = llmConfig.apiKey ?? "";
  } else {
    presetSel.value = "anthropic";
    presetSel.dispatchEvent(new Event("change"));
  }
})();

function currentConfig() {
  const preset = presetSel.value;
  return {
    preset,
    protocol: PRESETS[preset]?.protocol ?? "openai",
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value.trim(),
  };
}

function setStatus(msg, ok) {
  const el = $("status");
  el.textContent = msg;
  el.className = ok === undefined ? "" : ok ? "ok" : "err";
}

/** Demande la permission d'accéder à l'origine de l'endpoint (bypass CORS). */
async function requestHostPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin + "/*";
    const granted = await browser.permissions.request({ origins: [origin] });
    return granted;
  } catch {
    return false;
  }
}

$("save").addEventListener("click", async () => {
  const cfg = currentConfig();
  if (!cfg.baseUrl || !cfg.model) return setStatus("Endpoint et modèle sont requis.", false);
  if (!cfg.apiKey && !PRESETS[cfg.preset]?.noKey) return setStatus("Clé API requise pour ce fournisseur.", false);

  const granted = await requestHostPermission(cfg.baseUrl);
  await browser.storage.local.set({ llmConfig: cfg });
  setStatus(granted
    ? "Configuration enregistrée."
    : "Enregistré, mais l'accès à l'endpoint n'a pas été autorisé — les appels échoueront peut-être (CORS).", granted);
});

$("test").addEventListener("click", async () => {
  const cfg = currentConfig();
  if (!cfg.baseUrl || !cfg.model) return setStatus("Endpoint et modèle sont requis.", false);
  setStatus("Test en cours…");
  try {
    await requestHostPermission(cfg.baseUrl);
    const { text } = await callLLM(cfg, [{ role: "user", content: "Réponds uniquement : OK" }], [], "Tu es un test de connexion.");
    setStatus(`Connexion réussie — réponse : ${(text ?? "").slice(0, 60)}`, true);
  } catch (err) {
    setStatus(`Échec : ${err.message}`, false);
  }
});
