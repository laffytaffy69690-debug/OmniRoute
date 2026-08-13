# Standalone DeepSeek Web Reverse Proxy Server

A lightweight, extremely lean, zero-dependency reverse proxy that maps the standard OpenAI Chat Completions API format directly onto DeepSeek's Web UI completion protocol.

Perfect for integrating DeepSeek models with existing OpenAI-compatible developer tools, desktop interfaces, and SDKs.

## Features

- **OpenAI-Compatible Endpoint**: Exposes standard `/v1/chat/completions` API.
- **DeepSeek Proof of Work (PoW) Solver**: Bundles a pure-JavaScript Keccak-256 (SHA-3) sponge construction to dynamically answer and solve upstream PoW challenges.
- **Support for All Web Models**: Exposes both Default/Pro, R1/Thinking, and Search models.
- **Dynamic Stream (SSE) Parsing**: Streams results token-by-token and maps them directly to OpenAI formats.
- **First-class Thinking Support**: Automatically extracts R1 "THINK" blocks into `reasoning_content` delta payloads.
- **Dynamic Search Citation Extraction**: Parses citation markers and appends the bibliography (with names/URLs) at the end of responses.
- **Tool Calling (Function Calling)**: Serializes OpenAI-compatible `tools` lists into a custom prompt contract, then parses tags in the response back into structured OpenAI `tool_calls` formats.

---

## Quick Start

### 1. Extract / Copy Directory
The `deepseek-standalone-proxy` directory is completely self-contained. You can copy it anywhere on your machine or server.

### 2. Configure Token
The proxy uses your DeepSeek **userToken** to authenticate.
Get yours by opening **Chrome DevTools** on `chat.deepseek.com` and copying the value of the `userToken` key from **Local Storage**:

```json
{"value": "kjmJs/+8IkbVzNrlkwglmklP6/1c879IoGAC3fqdzec2USjWLtGpWWufZzMrtjX7", "__version": "0"}
```

You can pass this token in the `Authorization` header of your client requests:
```bash
Authorization: Bearer <your_user_token_or_json>
```

### 3. Run the Server
Run the proxy locally:
```bash
npm start
```
By default, the server listens on `http://localhost:20129`. To change the port, set the `PORT` environment variable:
```bash
PORT=8080 npm start
```

---

## API Endpoints

### Chat Completions (`POST /v1/chat/completions`)

Matches the OpenAI completions API payload format.

#### Example Request (No Streaming):
```bash
curl http://localhost:20129/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [
      { "role": "user", "content": "How many r in strawberry?" }
    ]
  }'
```

#### Example Request (Streaming / SSE):
```bash
curl http://localhost:20129/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [
      { "role": "user", "content": "How many r in strawberry?" }
    ],
    "stream": true
  }'
```

---

## Running Live Integration Tests

We have included a robust live test suite (`test.js`) that verifies standard completions, streaming, R1 thinking extraction, and tool calling:

```bash
# Run the test suite with your userToken
PORT=20129 node test.js
```
