// ── Comprehensive Integration and Feature Tests for DeepSeek Standalone Proxy ──
//
// Verifies standard completions, streaming (SSE), thinking (R1) extraction, and
// tool-calling translation end-to-end. Spawns the server as a background subprocess
// and executes real API requests against it.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import assert from "node:assert/strict";

const PORT = 20129;
const USER_TOKEN = process.env.DEEPSEEK_USER_TOKEN;

if (!USER_TOKEN) {
  console.error("❌ Error: DEEPSEEK_USER_TOKEN environment variable is not set.");
  console.error("Please run the tests with: DEEPSEEK_USER_TOKEN=\"your_token_here\" node test.js");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runTests() {
  console.log("🚀 Starting Standalone DeepSeek Proxy Server...");
  const serverProcess = spawn("node", ["server.js"], {
    env: { ...process.env, PORT },
    stdio: "inherit",
    cwd: __dirname
  });

  // Give the server a moment to start up and bind to the port
  await new Promise(resolve => setTimeout(resolve, 3000));

  let exitCode = 0;
  try {
    // ── Test 0: Model List Discovery ────────────────────────────────────────
    console.log("\n🧪 Test 0: Running model list discovery...");
    const resp0 = await fetch(`http://localhost:${PORT}/v1/models`, {
      method: "GET"
    });

    assert.equal(resp0.status, 200, "Model list should return status 200");
    const data0 = await resp0.json();
    console.log("Response (models):", JSON.stringify(data0, null, 2));
    assert.equal(data0.object, "list", "Should be an object of type 'list'");
    assert.ok(Array.isArray(data0.data), "Should return an array of models");
    assert.ok(data0.data.some(m => m.id === "deepseek-v4-pro"), "Should include deepseek-v4-pro");
    assert.ok(data0.data.some(m => m.id === "deepseek-v4-flash-think-search"), "Should include deepseek-v4-flash-think-search");


    // ── Test 1: Standard Non-Streaming Completions ──────────────────────────
    console.log("\n🧪 Test 1: Running standard non-streaming completions...");
    const resp1 = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${USER_TOKEN}`
      },
      body: JSON.stringify({
        model: "deepseek-web",
        messages: [{ role: "user", content: "Say the word 'Hello' and nothing else." }],
        stream: false
      })
    });

    if (resp1.status !== 200) {
      const errText = await resp1.text();
      console.error(`Error Response (HTTP ${resp1.status}):`, errText);
    }

    assert.equal(resp1.status, 200, "Standard completion should return status 200");
    const data1 = await resp1.json();
    console.log("Response:", JSON.stringify(data1, null, 2));
    assert.ok(data1.choices?.[0]?.message?.content, "Response content should not be empty");
    assert.match(data1.choices[0].message.content, /Hello/i, "Response should contain the word Hello");


    // ── Test 2: Standard Streaming completions (SSE) ──────────────────────
    console.log("\n🧪 Test 2: Running streaming completions (SSE)...");
    const resp2 = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${USER_TOKEN}`
      },
      body: JSON.stringify({
        model: "deepseek-web",
        messages: [{ role: "user", content: "Say 'Hello'" }],
        stream: true
      })
    });

    if (resp2.status !== 200) {
      const errText = await resp2.text();
      console.error(`Error Response (HTTP ${resp2.status}):`, errText);
    }

    assert.equal(resp2.status, 200, "Streaming completion should return status 200");
    const reader = resp2.body.getReader();
    const decoder = new TextDecoder();
    let streamContent = "";
    let sseDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunks = decoder.decode(value).split("\n\n");
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        if (chunk.startsWith("data: [DONE]")) {
          sseDone = true;
          continue;
        }
        if (chunk.startsWith("data: ")) {
          const payload = JSON.parse(chunk.slice(6));
          const delta = payload.choices?.[0]?.delta;
          if (delta?.content) {
            streamContent += delta.content;
            process.stdout.write(delta.content);
          }
        }
      }
    }
    console.log("\nComplete streamed reply:", streamContent);
    assert.ok(streamContent.length > 0, "Stream content should be captured");
    assert.ok(sseDone, "Stream should terminate with standard [DONE] signal");


    // ── Test 3: DeepSeek-R1 (Thinking/Reasoning) Extraction ──────────────────
    console.log("\n🧪 Test 3: Running DeepSeek-R1 (thinking model)...");
    const resp3 = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${USER_TOKEN}`
      },
      body: JSON.stringify({
        model: "deepseek-reasoner",
        messages: [{ role: "user", content: "Compare a banana and an apple in 10 words." }],
        stream: false
      })
    });

    if (resp3.status !== 200) {
      const errText = await resp3.text();
      console.error(`Error Response (HTTP ${resp3.status}):`, errText);
    }

    assert.equal(resp3.status, 200, "Reasoner completion should return status 200");
    const data3 = await resp3.json();
    console.log("Response with thinking:", JSON.stringify(data3, null, 2));
    assert.ok(data3.choices?.[0]?.message?.content, "Reasoner content should not be empty");
    assert.ok(data3.choices?.[0]?.message?.reasoning_content, "Reasoner should populate reasoning_content");


    // ── Test 4: Tool Calling (Function Calling) ──────────────────────────────
    console.log("\n🧪 Test 4: Running tool-calling integration...");
    const resp4 = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${USER_TOKEN}`
      },
      body: JSON.stringify({
        model: "deepseek-web",
        messages: [{ role: "user", content: "Tell the user that their task is complete by calling the 'task_complete' function." }],
        tools: [
          {
            type: "function",
            function: {
              name: "task_complete",
              description: "Notify the user that their task has completed successfully.",
              parameters: {
                type: "object",
                properties: {
                  status: { type: "string", description: "The exit status." }
                },
                required: ["status"]
              }
            }
          }
        ],
        stream: false
      })
    });

    if (resp4.status !== 200) {
      const errText = await resp4.text();
      console.error(`Error Response (HTTP ${resp4.status}):`, errText);
    }

    assert.equal(resp4.status, 200, "Tool calling should return status 200");
    const data4 = await resp4.json();
    console.log("Response with tool calls:", JSON.stringify(data4, null, 2));
    const toolCalls = data4.choices?.[0]?.message?.tool_calls;
    assert.ok(Array.isArray(toolCalls), "Should return a list of tool calls");
    assert.equal(toolCalls[0].function.name, "task_complete", "Should have matched the expected function name");

    console.log("\n🎉 ALL standalone tests passed successfully!");
  } catch (err) {
    console.error("\n❌ Test failure:", err);
    exitCode = 1;
  } finally {
    console.log("\n🧹 Cleaning up and stopping proxy server...");
    serverProcess.kill();
    // Ensure process terminates
    await new Promise(resolve => setTimeout(resolve, 1000));
    process.exit(exitCode);
  }
}

runTests();
