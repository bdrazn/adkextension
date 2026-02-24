# ADK Chat — Deploy & Build

This folder contains scripts to **build the VSIX** and **deploy the ADK server to Vercel**, so you can use the extension from anywhere.

## Code isolation (share publicly without your code)

**Your extension code is never committed to this folder.** When you run `build:server`, it copies `extension/server` and `extension/agents` into `api/` — but `api/server/` and `api/agents/` are **gitignored**. They exist only locally and are never pushed.

To share `adk-chat-deploy` publicly without exposing your code:

- Keep `extension/` in a **separate private repo**, or
- Add `extension/` to `.gitignore` in the parent repo if both live together

Then share only the `adk-chat-deploy` folder. Recipients will need their own extension (or the public one) to deploy.

## Structure

```
adk-chat-deploy/
├── api/                 # Vercel serverless (populated by build:server)
│   ├── index.mjs        # Entry point
│   ├── server/          # Copied from extension/server
│   └── agents/.build/   # Prebuilt agent (from extension/agents/.build)
├── dist/                # Output: adk-chat.vsix
├── scripts/
│   ├── build-vsix.mjs   # Build VSIX from extension
│   └── prepare-vercel-server.mjs  # Copy server + agents for Vercel
├── vercel.json
└── package.json
```

## Quick Start

### 1. Build the VSIX

```bash
cd adk-chat-deploy
npm install
npm run build:vsix
```

Output: `dist/adk-chat.vsix` — install in VS Code via **Extensions → ... → Install from VSIX**.

### 2. Deploy to Vercel (via GitHub)

1. **Prepare the deploy folder** (from project root, with `extension/` present):
   ```bash
   cd adk-chat-deploy
   npm run build:server
   ```

2. **Push to GitHub** — create a repo and push the whole `adk-chat-deploy` folder:
   ```bash
   cd adk-chat-deploy
   git init
   git add .
   git commit -m "Initial deploy"
   git remote add origin https://github.com/YOUR_USERNAME/adkextension.git
   git push -u origin main
   ```

3. **Connect Vercel** — at [vercel.com](https://vercel.com) → New Project → Import your GitHub repo. Deploy.

### 3. Configure the Extension

In VS Code settings:

- `adkChat.useEmbeddedServer`: **false**
- `adkChat.serverUrl`: **https://your-project.vercel.app**

## Complexity & Limitations

### Medium complexity

| Aspect | Notes |
|--------|-------|
| **VSIX build** | Straightforward — runs `vsce package` on the extension |
| **Vercel deploy** | Server runs as serverless; 60s timeout (Pro plan) |
| **Sessions** | In-memory per invocation — no persistence across requests |
| **Tool executor** | **Critical limitation** — see below |

### Tool executor (file edits, terminal)

The ADK agent calls the **tool executor** (file edits, terminal, grep, etc.) via HTTP. The tool executor runs **inside the extension** on the user's machine.

When the server is on **Vercel**:
- Vercel runs in the cloud
- The tool executor is at `http://localhost:8006` on the user's machine
- **Vercel cannot reach the user's localhost**

**Options:**

1. **Embedded server (default)** — Use `useEmbeddedServer: true`. The server runs locally. Full tool support. No Vercel needed.

2. **Vercel + tunnel** — Expose the tool executor via [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/). Pass the tunnel URL as `toolExecutorUrl`. The extension would need to support/config this.

3. **Vercel without tools** — Use Vercel for chat-only (no file edits, no terminal). Set `toolExecutorUrl` to empty or a no-op. The agent can respond but cannot edit files.

### Session persistence

Vercel serverless is stateless. Sessions are in-memory and lost between cold starts. For long conversations, use the embedded server or add a persistence layer (Vercel KV, Upstash Redis).

## Workflow

```
extension/          ← Source (current codebase)
    ↓ build:vsix
dist/adk-chat.vsix  ← Install in VS Code

extension/          ← Source
    ↓ build:server (copy server + agents)
adk-chat-deploy/api/
    ↓ vercel deploy
https://xxx.vercel.app  ← Extension connects here
```

## Env vars (Vercel)

Set in Vercel project settings:

- `OPENAI_COMPATIBLE_BASE_URL` — Ollama/LM Studio URL (e.g. `https://your-ollama.com/v1`)
- `OPENAI_COMPATIBLE_MODEL` — Default model name
