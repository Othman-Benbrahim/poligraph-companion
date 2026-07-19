/**
 * Client LLM unifié — BYOK (Bring Your Own Key).
 * Deux protocoles : Anthropic natif, et "compatible OpenAI" qui couvre
 * tous les autres fournisseurs (y compris les modèles locaux).
 * Architecture reprise de l'add-on In Truth.
 */

export const PRESETS = {
  custom:     { label: "Personnalisé (saisie manuelle)", protocol: "openai", baseUrl: "" },
  anthropic:  { label: "Anthropic (Claude)", protocol: "anthropic", baseUrl: "https://api.anthropic.com", placeholderModel: "claude-sonnet-4-6" },
  openrouter: { label: "OpenRouter — 290+ modèles", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", placeholderModel: "anthropic/claude-sonnet-4.6" },
  openai:     { label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", placeholderModel: "gpt-4o-mini" },
  gemini:     { label: "Google Gemini", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", placeholderModel: "gemini-2.0-flash" },
  groq:       { label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", placeholderModel: "llama-3.3-70b-versatile" },
  mistral:    { label: "Mistral", protocol: "openai", baseUrl: "https://api.mistral.ai/v1", placeholderModel: "mistral-small-latest" },
  deepseek:   { label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", placeholderModel: "deepseek-chat" },
  xai:        { label: "xAI (Grok)", protocol: "openai", baseUrl: "https://api.x.ai/v1", placeholderModel: "grok-3-mini" },
  together:   { label: "Together AI", protocol: "openai", baseUrl: "https://api.together.xyz/v1", placeholderModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  fireworks:  { label: "Fireworks AI", protocol: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", placeholderModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  perplexity: { label: "Perplexity", protocol: "openai", baseUrl: "https://api.perplexity.ai", placeholderModel: "sonar" },
  lmstudio:   { label: "LM Studio (local)", protocol: "openai", baseUrl: "http://localhost:1234/v1", placeholderModel: "(modèle chargé dans LM Studio)", noKey: true },
  ollama:     { label: "Ollama (local)", protocol: "openai", baseUrl: "http://localhost:11434/v1", placeholderModel: "llama3.1", noKey: true },
};

/**
 * Appel non-streamé, format unifié.
 * @param {object} cfg       { protocol, baseUrl, apiKey, model }
 * @param {Array}  messages  Historique au format unifié :
 *   { role: "user"|"assistant", content: string }
 *   { role: "assistant", toolCalls: [{id, name, args}] }
 *   { role: "tool", toolCallId, name, content }
 * @param {Array}  tools     [{ name, description, parameters (JSON Schema) }]
 * @param {string} system    Prompt système
 * @returns {Promise<{text: string|null, toolCalls: Array<{id,name,args}>}>}
 */
export async function callLLM(cfg, messages, tools, system) {
  return cfg.protocol === "anthropic"
    ? callAnthropic(cfg, messages, tools, system)
    : callOpenAI(cfg, messages, tools, system);
}

/* ----------------------------- Anthropic ----------------------------- */

async function callAnthropic(cfg, messages, tools, system) {
  const anthMessages = messages.map((m) => {
    if (m.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      return { role: "assistant", content: blocks };
    }
    return { role: m.role, content: m.content };
  });

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2000,
      system,
      messages: anthMessages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
  });
  if (!res.ok) throw new Error(`${res.status} — ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();

  let text = null;
  const toolCalls = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") text = (text ?? "") + block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
  }
  return { text, toolCalls };
}

/* -------------------------- Compatible OpenAI ------------------------ */

async function callOpenAI(cfg, messages, tools, system) {
  const oaMessages = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") {
      oaMessages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      oaMessages.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id, type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
    } else {
      oaMessages.push({ role: m.role, content: m.content });
    }
  }

  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: oaMessages,
      temperature: 0.2,
      tools: tools.length ? tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })) : undefined,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} — ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();

  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* modèle faible : args illisibles */ }
    return { id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name, args };
  });
  return { text: msg.content ?? null, toolCalls };
}
