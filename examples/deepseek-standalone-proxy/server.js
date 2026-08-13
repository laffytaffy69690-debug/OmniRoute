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
  // Try Authorization header first (Bearer <token>)
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
    expiresAt: Math.floor(Date.now() / 1000) + 3500, // expire slightly early (DeepSeek token has 1h life)
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
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

function parseToolCalls(text, nonce, tools) {
  if (typeof text !== "string" || !text.includes("<tool>")) {
    return { content: text, toolCalls: null };
  }

  const toolCalls = [];
  const tagRe = /<tool>\s*([\s\S]*?)\s*<\/tool>/g;
  let match;
  let content = text;
  const ranges = [];

  const requestedNames = (tools || []).map(t => t?.function?.name).filter(Boolean);

  while ((match = tagRe.exec(text)) !== null) {
    const inner = match[1].trim();
    try {
      // Loose JSON parse
      const parsed = JSON.parse(inner.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3').replace(/,\s*([}\]])/g, "$1"));
      if (parsed && typeof parsed.name === "string") {
        if (nonce && parsed._nonce !== nonce) continue; // Nonce validation
        if (requestedNames.length > 0 && !requestedNames.includes(parsed.name)) continue;

        const args = typeof parsed.arguments === "object" ? JSON.stringify(parsed.arguments) : String(parsed.arguments || "{}");
        toolCalls.push({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: { name: parsed.name, arguments: args }
        });
        ranges.push({ start: match.index, end: tagRe.lastIndex });
      }
    } catch {
      // ignore malformed
    }
  }

  // Strip accepted tags from content
  if (toolCalls.length > 0) {
    const sortedRanges = ranges.sort((a, b) => b.start - a.start);
    for (const range of sortedRanges) {
      content = content.slice(0, range.start) + content.slice(range.end);
    }
    content = content.replace(/\n{3,}/g, "\n\n").trim();
    return { content, toolCalls };
  }

  return { content: text, toolCalls: null };
}

// ── Prompt Formatting ────────────────────────────────────────────────────────

function messagesToPrompt(messages, toolPrompt) {
  const systemParts = [];
  if (toolPrompt) systemParts.push(toolPrompt);

  const lines = [];
  const callNameById = new Map();

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
            callNameById.set(tc.id, tc.function.name);
            parts.push(`<tool>{"name": "${tc.function.name}", "arguments": ${tc.function.arguments}}</tool>`);
          }
        }
      }
      if (parts.length > 0) lines.push(`Assistant: ${parts.join("\n")}`);
    } else if (m.role === "tool") {
      const name = callNameById.get(m.tool_call_id) || m.name || "tool";
      lines.push(`Tool result (${name}): ${text || "(no output)"}`);
    }
  }

  const finalParts = [];
  if (systemParts.length > 0) finalParts.push(systemParts.join("\n\n"));
  if (lines.length > 0) finalParts.push(lines.join("\n\n"));

  return finalParts.join("\n\n");
}

// ── Unified DeepSeek Web Response Parser (Handles ALL Upstream Event Formats) ─

function cleanStreamTokens(text) {
  return text.replace(/FINISHED/g, "").replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, "");
}

function makeUnifiedParser(onText, onThinkingText, onSearchResults, initialPath = "content") {
  let currentPath = initialPath;

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
      if (!line.startsWith("data: ")) return;
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

    const prompt = messagesToPrompt(messages, toolPrompt);

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
        },
        isThinking ? "thinking" : "content"
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
        (results) => { searchResults.push(...results); },
        isThinking ? "thinking" : "content"
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
