// ── Standalone DeepSeek Web Reverse Proxy Server (Pure Node.js) ────────────
//
// An extremely lean, zero-dependency reverse proxy that transforms DeepSeek Web UI
// endpoint (/api/v0/chat/completion) into an OpenAI-compatible /v1/chat/completions API.
//
// Features:
// - Standalone: Exposes standard /v1/chat/completions endpoint using native Node.js HTTP.
// - Model Discovery: Exposes standard /v1/models endpoint listing all pro, flash, think, and search variants.
// - Session Persistence & Caching: Caches short-lived access tokens to limit /users/current calls.
// - Real-time PoW Solving: Integrates the pure JS Keccak solver to answer challenges dynamically.
// - OpenAI Stream Formatting: Converts DeepSeek's custom events into standard SSE and stop/stop reasons.
// - Thinking Model support: Extracts R1 "THINK" blocks into `reasoning_content` delta payloads.
// - DeepSeek Web Search citation extraction: Parses [citation:X] tags and appends formatted bibliography.
// - Tool Calling Translation: Serializes OpenAI tools to a prompt contract and parses response tags back.

import http from "node:http";
import { solveDeepSeekPow } from "./pow-solver.js";

const PORT = process.env.PORT || 20129;
const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
const DEEPSEEK_API_BASE = `${DEEPSEEK_WEB_BASE}/api`;

const FAKE_HEADERS = {
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": DEEPSEEK_WEB_BASE,
  "Referer": `${DEEPSEEK_WEB_BASE}/`,
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "X-Client-Bundle-Id": "com.deepseek.chat",
  "X-Client-Locale": "en-US",
  "X-Client-Platform": "web",
  "X-Client-Version": "2.0.0",
};

const MODELS = [
  { "id": "deepseek-v4-pro", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-pro-think", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-pro-search", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-pro-think-search", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-flash", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-flash-think", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-flash-search", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-v4-flash-think-search", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-chat", "object": "model", "owned_by": "deepseek" },
  { "id": "deepseek-reasoner", "object": "model", "owned_by": "deepseek" },
  { "id": "DeepSeek-R1", "object": "model", "owned_by": "deepseek" },
  { "id": "DeepSeek-R1-Search", "object": "model", "owned_by": "deepseek" },
  { "id": "DeepSeek-V3.2", "object": "model", "owned_by": "deepseek" },
  { "id": "DeepSeek-Search", "object": "model", "owned_by": "deepseek" }
];

// Token cache (userToken -> { accessToken, expiresAt })
const tokenCache = new Map();

// Helper to extract the userToken from credentials
function extractUserToken(authHeader) {
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const raw = authHeader.slice(7).trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.value === "string") return parsed.value;
    } catch {
      // not JSON
    }
    return raw;
  }
  return null;
}

// Generate cookies matching live browser
function generateFakeCookie() {
  const ts = Date.now();
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const uid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1000)}; _frid=${uid()}`;
}

// Fetch long-lived accessToken using the userToken/Cookie
async function acquireAccessToken(userToken) {
  const cached = tokenCache.get(userToken);
  if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) {
    return cached.accessToken;
  }

  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
    headers: {
      "Authorization": `Bearer ${userToken}`,
      ...FAKE_HEADERS,
    }
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Invalid or expired userToken (Get a new one from chat.deepseek.com LocalStorage)");
  }
  if (!resp.ok) {
    throw new Error(`Failed to acquire token: HTTP ${resp.status}`);
  }

  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  if (!bizData?.token) {
    throw new Error(`Failed to extract accessToken: ${json?.msg || "Unknown upstream error"}`);
  }

  const accessToken = bizData.token;
  tokenCache.set(userToken, {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + 3500,
  });

  return accessToken;
}

// Create a new DeepSeek web session
async function createSession(accessToken) {
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
    method: "POST",
    headers: {
      ...FAKE_HEADERS,
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Cookie": generateFakeCookie(),
    },
    body: JSON.stringify({}),
  });

  if (!resp.ok) throw new Error(`Failed to create session: HTTP ${resp.status}`);
  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  const id = bizData?.chat_session?.id;
  if (!id) throw new Error("No session ID returned from DeepSeek");
  return id;
}

// Delete session on DeepSeek (best effort)
async function deleteSession(accessToken, sessionId) {
  try {
    await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/delete`, {
      method: "POST",
      headers: {
        ...FAKE_HEADERS,
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ chat_session_id: sessionId }),
    });
  } catch {
    // ignore
  }
}

// Create and solve PoW challenge
async function getSolvedPowResponse(accessToken) {
  const resp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers: {
      ...FAKE_HEADERS,
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });

  if (!resp.ok) throw new Error(`Failed to fetch PoW challenge: HTTP ${resp.status}`);
  const json = await resp.json();
  const bizData = json?.data?.biz_data || json?.biz_data;
  const challenge = bizData?.challenge;
  if (!challenge?.challenge) throw new Error("Invalid PoW challenge payload");

  const answer = solveDeepSeekPow(
    challenge.algorithm,
    challenge.challenge,
    challenge.salt,
    challenge.difficulty,
    challenge.expire_at
  );

  if (answer < 0) throw new Error("PoW solver failed");

  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    })
  ).toString("base64");
}

// ── Tool Calling Prompt Serializer & Parser ──────────────────────────────────

function serializeToolsPrompt(tools, nonce) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const lines = [];
  for (const t of tools) {
    const fn = t?.function;
    if (!fn?.name) continue;
    const desc = fn.description || "";
    const params = fn.parameters ? JSON.stringify(fn.parameters) : "";
    lines.push(`- ${fn.name}${desc ? `: ${desc}` : ""}${params ? `\n  parameters: ${params}` : ""}`);
  }
  if (lines.length === 0) return "";

  return [
    "You can call tools. To call a tool, output ONLY this exact block (no markdown fence):",
    `<tool>{"name": "<tool_name>", "arguments": { ... }, "_nonce": "${nonce}"}</tool>`,
    "Rules:",
    "- Use exactly <tool>...</tool>. Do NOT use <tool:name>, <tool_call>, <name>, <parameter>, attributes, or code fences.",
    `- Include the secret binding "_nonce": "${nonce}" exactly as shown.`,
    '- "name" must be one of the tools below; "arguments" must be a JSON object.',
    "- When a tool is needed, emit the <tool> block instead of only describing the plan.",
    "- Emit one <tool> block per call; you may put several blocks back to back.",
    "- If no tool is needed, just answer normally without any <tool> block.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

function buildToolReminder(toolPrompt) {
  const names = (toolPrompt.match(/^- [^:\n]+/gm) || []).map((s) => s.slice(2).trim()).join(", ");
  return (
    "\n\n[Client protocol reminder: the client-tool contract in the system instructions " +
    "is active in this conversation. These client tools ARE available via the <tool> " +
    "block protocol" +
    (names ? ": " + names : "") +
    ".]"
  );
}

function tokenizeToolTags(text) {
  const tokens = [];
  const tagRe = /<(\/?)(?:tool_call|tool)(:[A-Za-z0-9_.+-]+)?((?:\s[^>]*)?)\/?>/g;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    tokens.push({
      start: m.index,
      end: tagRe.lastIndex,
      closing: m[1] === "/",
      suffix: m[2] ? m[2].slice(1) : "",
      attrs: m[3] || "",
    });
  }
  return tokens;
}

function pairToolBlocks(tokens, textLen) {
  const blocks = [];
  const stack = [];
  for (const tok of tokens) {
    if (!tok.closing) {
      stack.push(tok);
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    blocks.push({ open, close: tok, innerStart: open.end, innerEnd: tok.start });
  }
  for (const open of stack) {
    const synthetic = {
      start: textLen,
      end: textLen,
      closing: true,
      suffix: "",
      attrs: "",
    };
    blocks.push({ open, close: synthetic, innerStart: open.end, innerEnd: textLen });
  }
  return blocks;
}

function getAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("|')`);
  const m = re.exec(attrs);
  if (!m) return null;
  const quote = m[1];
  let j = m.index + m[0].length;
  let out = "";
  while (j < attrs.length) {
    const ch = attrs[j];
    if (ch === "\\") {
      out += attrs[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (ch === quote) break;
    out += ch;
    j += 1;
  }
  return out;
}

function getXmlChild(inner, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(inner);
  return m ? m[1].trim() : null;
}

function buildArgsFromParameters(inner) {
  const paramRe = /<parameter\b([^>]*?)\/?>(?:((?:(?!<parameter\b)[\s\S])*?)<\/parameter>)?/gi;
  const out = {};
  let found = false;
  let m;
  while ((m = paramRe.exec(inner)) !== null) {
    const attrs = m[1] || "";
    const body = m[2];
    const name = getAttr(attrs, "name");
    if (!name) continue;
    const value = getAttr(attrs, "content") ?? (typeof body === "string" ? body.trim() : "");
    out[name] = value;
    found = true;
  }
  return found ? out : null;
}

function convertSingleQuotedStrings(value) {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      result += ch === '"' && inSingle ? '\\"' : ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (inSingle) {
        result += '\\"';
      } else {
        inDouble = !inDouble;
        result += ch;
      }
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += '"';
      continue;
    }
    result += ch;
  }
  return result;
}

function replacePythonLiterals(value) {
  let result = "";
  let inString = false;
  let escaped = false;
  let token = "";

  const flushToken = () => {
    if (token === "True") result += "true";
    else if (token === "False") result += "false";
    else if (token === "None") result += "null";
    else result += token;
    token = "";
  };

  for (const ch of value) {
    if (escaped) {
      if (token) flushToken();
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (token) flushToken();
      result += ch;
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      if (token) flushToken();
      inString = !inString;
      result += ch;
      continue;
    }
    if (!inString && /[A-Za-z]/.test(ch)) {
      token += ch;
      continue;
    }
    if (token) flushToken();
    result += ch;
  }
  if (token) flushToken();
  return result;
}

function normalizeLooseJson(value) {
  return replacePythonLiterals(convertSingleQuotedStrings(value))
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, "$1");
}

function stripCodeFence(value) {
  return value
    .trim()
    .replace(/^```(?:json|javascript|js|python)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseLooseJsonObject(raw) {
  const trimmed = stripCodeFence(raw);
  for (const candidate of [trimmed, normalizeLooseJson(trimmed)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  return null;
}

function extractCall(tagName, innerRaw, requestedNames) {
  const inner = innerRaw.trim();
  const nameChild = getXmlChild(inner, "name");
  const argsChild = getXmlChild(inner, "arguments") ?? getXmlChild(inner, "parameters");
  const paramObj = argsChild ? null : buildArgsFromParameters(inner);
  const hasXmlChildren = !!nameChild || !!argsChild || !!paramObj;

  const json = hasXmlChildren ? null : parseLooseJsonObject(inner);
  const jsonName = json ? (json.name || json.type) : null;

  let name = nameChild || jsonName || tagName;
  if (!name) return null;

  if (requestedNames.includes(name)) {
    // exact match
  } else {
    const matched = requestedNames.find(n => n.toLowerCase() === name.toLowerCase());
    if (matched) name = matched;
  }

  let argsValue;
  if (argsChild) {
    argsValue = parseLooseJsonObject(argsChild) ?? argsChild;
  } else if (paramObj) {
    argsValue = paramObj;
  } else if (json) {
    if (json.arguments !== undefined) argsValue = json.arguments;
    else if (json.params !== undefined) argsValue = json.params;
    else if (name === tagName) {
      argsValue = json;
    } else {
      const { name: _n, type: _t, id: _i, command: _c, arguments: _a, params: _p, ...rest } = json;
      argsValue = rest;
    }
  } else {
    argsValue = {};
  }

  const argsStr = typeof argsValue === "object" ? JSON.stringify(argsValue) : String(argsValue || "{}");
  return { name, arguments: argsStr };
}

function parseToolCalls(text, nonce, tools) {
  if (typeof text !== "string" || (!text.includes("<tool>") && !text.includes("<tool_call>"))) {
    return { content: text, toolCalls: null };
  }

  const tokens = tokenizeToolTags(text);
  if (tokens.length === 0) return { content: text, toolCalls: null };

  const requestedNames = (tools || []).map(t => t?.function?.name).filter(Boolean);
  const blocks = pairToolBlocks(tokens, text.length);

  const isLeaf = (b) =>
    !blocks.some((o) => o !== b && o.open.start >= b.innerStart && o.close.end <= b.innerEnd);

  const toolCalls = [];
  const acceptedRanges = [];

  for (const block of blocks.filter(isLeaf).sort((a, b) => a.open.start - b.open.start)) {
    const tagName = block.open.suffix || getAttr(block.open.attrs, "name") || getAttr(block.open.attrs, "id") || "";
    const inner = text.slice(block.innerStart, block.innerEnd);
    const call = extractCall(tagName, inner, requestedNames);
    if (!call) continue;

    if (nonce) {
      const parsed = parseLooseJsonObject(inner);
      if (parsed && typeof parsed.name === "string" && parsed._nonce !== undefined && parsed._nonce !== nonce) {
        continue;
      }
    }

    toolCalls.push({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    });
    acceptedRanges.push({ start: block.open.start, end: block.close.end });
  }

  if (toolCalls.length === 0) {
    return { content: text, toolCalls: null };
  }

  const sortedRanges = acceptedRanges.sort((a, b) => b.start - a.start);
  let content = text;
  for (const range of sortedRanges) {
    content = content.slice(0, range.start) + content.slice(range.end);
  }
  content = content.replace(/\n{3,}/g, "\n\n").trim();
  return { content, toolCalls };
}

// ── Prompt Formatting & Trajectory Replay ────────────────────────────────────

function messagesToPrompt(messages, toolPrompt) {
  const systemParts = [];
  if (toolPrompt) systemParts.push(toolPrompt);

  const lines = [];
  const callNameById = new Map();
  let sawToolActivity = false;

  for (const m of messages) {
    const text = String(m.content || "").trim();
    if (m.role === "system") {
      if (text) systemParts.push(text);
    } else if (m.role === "user") {
      if (text) lines.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      const parts = [];
      if (text) parts.push(text);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.function?.name) {
            const tcName = tc.function.name;
            const tcArgs = typeof tc.function.arguments === "object" ? JSON.stringify(tc.function.arguments) : String(tc.function.arguments || "{}");
            callNameById.set(tc.id, tcName);
            parts.push(`<tool>{"name": "${tcName}", "arguments": ${tcArgs}}</tool>`);
            sawToolActivity = true;
          }
        }
      }
      if (parts.length > 0) lines.push(`Assistant: ${parts.join("\n")}`);
    } else if (m.role === "tool") {
      const name = callNameById.get(m.tool_call_id) || m.name || "tool";
      lines.push(`Tool result (${name}): ${text || "(no output)"}`);
      sawToolActivity = true;
    }
  }

  const finalParts = [];
  if (systemParts.length > 0) finalParts.push(systemParts.join("\n\n"));
  if (lines.length > 0) finalParts.push(lines.join("\n\n"));
  if (sawToolActivity) {
    finalParts.push(
      "Continue the task using the tool results above. Do NOT repeat tool calls that already " +
      "succeeded; perform the next step or give the final answer."
    );
  }

  return finalParts.join("\n\n");
}

// ── Unified DeepSeek Web Response Parser (Handles ALL Upstream Event Formats) ─

function cleanStreamTokens(text) {
  return text.replace(/FINISHED/g, "").replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, "");
}

function makeUnifiedParser(onText, onThinkingText, onSearchResults) {
  let currentPath = "";

  const sendByPath = (raw) => {
    const text = cleanStreamTokens(raw);
    if (!text) return;
    if (currentPath === "thinking") {
      onThinkingText(text);
    } else {
      onText(text);
    }
  };

  const applyFragmentType = (frag) => {
    const type = String(frag?.type || "").toUpperCase();
    if (type === "THINK") currentPath = "thinking";
    else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
  };

  const handleFragment = (frag, setPathFromType = false) => {
    if (setPathFromType) applyFragmentType(frag);
    if (typeof frag?.content !== "string" || frag.content.length === 0) return;
    if (!setPathFromType) {
      const type = String(frag?.type || "").toUpperCase();
      if (type === "THINK") currentPath = "thinking";
      else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
    }
    sendByPath(frag.content);
  };

  return {
    parseLine(line) {
      if (!line.startsWith("data: ") && !line.startsWith("data:")) return;
      const payload = line.replace(/^data:\s*/, "").trim();
      if (payload === "[DONE]") return;

      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }

      const p = data?.p;
      const v = data?.v;

      if (v && typeof v === "object" && v.response) {
        if (v.response.thinking_enabled === true) currentPath = "thinking";
        else if (v.response.thinking_enabled === false) currentPath = "content";
        const fragments = v.response.fragments;
        if (Array.isArray(fragments)) {
          for (const frag of fragments) handleFragment(frag, false);
        }
      }

      if (p === "response/fragments") {
        if (Array.isArray(v)) {
          for (const frag of v) handleFragment(frag, true);
        } else if (v && typeof v === "object") {
          handleFragment(v, true);
        }
      }

      if (p === "response" && Array.isArray(v)) {
        for (const entry of v) {
          if (entry?.p === "response" && entry?.v?.thinking_enabled === true) {
            currentPath = "thinking";
          }
        }
      }

      if (p === "response/search_results" && Array.isArray(v)) {
        onSearchResults(v);
        return;
      }

      if (typeof v === "string") {
        sendByPath(v);
      } else if (Array.isArray(v) && p === "response") {
        for (const entry of v) {
          if (Array.isArray(entry?.v)) {
            const joined = entry.v.map((item) => item?.content || "").join("");
            if (joined) sendByPath(joined);
          }
        }
      }
    }
  };
}

// Main Request Handler
async function handleCompletions(req, res, reqBody) {
  try {
    const {
      model = "deepseek-web",
      messages = [],
      stream = false,
      tools = []
    } = reqBody;

    const userToken = extractUserToken(req.headers["authorization"]);
    if (!userToken) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid credentials: Provide Bearer userToken", type: "invalid_request_error" } }));
      return;
    }

    const modelLower = model.toLowerCase();
    const isExpert = modelLower.includes("pro") || modelLower.includes("expert");
    const isThinking = modelLower.includes("r1") || modelLower.includes("think") || modelLower.includes("reason") || reqBody.thinking_enabled;
    const isSearch = modelLower.includes("search") || reqBody.search_enabled;

    // Generate nonce for tool calling
    const nonce = Math.random().toString(36).slice(2, 10);
    const toolPrompt = tools.length > 0 ? serializeToolsPrompt(tools, nonce) : "";

    // Dual-placement for tool calling
    const effectiveMessages = [...messages];
    if (tools.length > 0) {
      const reminder = buildToolReminder(toolPrompt);
      for (let i = effectiveMessages.length - 1; i >= 0; i--) {
        if (effectiveMessages[i]?.role === "user") {
          effectiveMessages[i] = { ...effectiveMessages[i], content: effectiveMessages[i].content + reminder };
          break;
        }
      }
    }

    const prompt = messagesToPrompt(effectiveMessages, toolPrompt);

    // 1. Authenticate with DeepSeek
    const accessToken = await acquireAccessToken(userToken);

    // 2. Resolve PoW Challenge
    const powAnswer = await getSolvedPowResponse(accessToken);

    // 3. Create Upstream Session
    const sessionId = await createSession(accessToken);

    // Prepare upstream payload
    const upstreamPayload = {
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: isExpert ? "expert" : "default",
      prompt,
      ref_file_ids: [],
      thinking_enabled: isThinking,
      search_enabled: isSearch,
      preempt: false,
    };

    const upstreamHeaders = {
      ...FAKE_HEADERS,
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "X-Ds-Pow-Response": powAnswer,
      "X-Client-Timezone-Offset": String(new Date().getTimezoneOffset() * -60),
      "Cookie": generateFakeCookie(),
    };

    // 4. Request completion
    const upstreamResp = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/completion`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamPayload)
    });

    if (!upstreamResp.ok) {
      await deleteSession(accessToken, sessionId);
      res.writeHead(upstreamResp.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `DeepSeek API error: HTTP ${upstreamResp.status}`, type: "upstream_error" } }));
      return;
    }

    // Determine return headers
    const reqId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let emittedRole = false;
      const searchResults = [];

      const emitChunk = (delta, finishReason = null) => {
        res.write(`data: ${JSON.stringify({
          id: reqId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        })}\n\n`);
      };

      const ensureRole = () => {
        if (!emittedRole) {
          emittedRole = true;
          emitChunk({ role: "assistant", content: "" });
        }
      };

      const parser = makeUnifiedParser(
        (txt) => {
          ensureRole();
          emitChunk({ content: txt });
        },
        (txt) => {
          ensureRole();
          emitChunk({ reasoning_content: txt });
        },
        (results) => {
          searchResults.push(...results);
        }
      );

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            parser.parseLine(line);
          }
        }

        // Output search citations if any
        if (searchResults.length > 0) {
          const bibliography = "\n\n" + searchResults
            .map((r, i) => `[${i + 1}]: [${r.title}](${r.url})`)
            .join("\n");
          ensureRole();
          emitChunk({ content: bibliography });
        }

        emitChunk({}, "stop");
        res.write("data: [DONE]\n\n");
      } catch (err) {
        // stream interrupted
      } finally {
        res.end();
        await deleteSession(accessToken, sessionId);
      }

    } else {
      // Non-streaming completion
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoningContent = "";
      const searchResults = [];

      const parser = makeUnifiedParser(
        (txt) => { content += txt; },
        (txt) => { reasoningContent += txt; },
        (results) => { searchResults.push(...results); }
      );

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          parser.parseLine(line);
        }
      }

      await deleteSession(accessToken, sessionId);

      if (searchResults.length > 0) {
        content += "\n\n" + searchResults
          .map((r, i) => `[${i + 1}]: [${r.title}](${r.url})`)
          .join("\n");
      }

      // Check for tool calling
      let toolCalls = null;
      let finishReason = "stop";
      if (tools.length > 0) {
        const parsedTools = parseToolCalls(content, nonce, tools);
        content = parsedTools.content;
        toolCalls = parsedTools.toolCalls;
        if (toolCalls) finishReason = "tool_calls";
      }

      const responseMessage = { role: "assistant", content };
      if (reasoningContent) responseMessage.reasoning_content = reasoningContent;
      if (toolCalls) {
        responseMessage.tool_calls = toolCalls;
        if (!content) responseMessage.content = null;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: reqId,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: responseMessage,
          finish_reason: finishReason
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    }

  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Proxy Error: ${err.message}`, type: "api_error" } }));
  }
}

// Start HTTP server
const server = http.createServer(async (req, res) => {
  // CORS support
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Model list endpoint
  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODELS }));
    return;
  }

  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const reqBody = JSON.parse(body);
        await handleCompletions(req, res, reqBody);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }));
});

server.listen(PORT, () => {
  console.log(`DeepSeek Standalone Web Proxy running on http://localhost:${PORT}`);
});
