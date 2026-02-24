/**
 * Vercel serverless entry — mounts the ADK Express server.
 * Requires: npm run build:server (copies extension/server + agents to api/)
 *
 * IMPORTANT: The ADK server calls the tool executor via HTTP. When running on Vercel,
 * toolExecutorUrl points to the user's machine. The Vercel server CANNOT reach
 * localhost on the user's machine. For full tool support (file edits, terminal),
 * users must either:
 * - Use the embedded server (useEmbeddedServer: true) — runs locally
 * - Expose their tool executor via a tunnel (ngrok, cloudflare) and pass that URL
 *
 * Without a reachable tool executor, the agent can still respond but cannot edit files
 * or run terminal commands.
 */
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, 'agents');

let appPromise = null;

export default async function handler(req, res) {
  try {
    appPromise = appPromise ?? createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error('[api] Startup error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}

async function createApp() {
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;
  const {
    Runner,
    InMemorySessionService,
    InMemoryMemoryService,
    InMemoryArtifactService,
    StreamingMode,
    stringifyContent,
  } = await import('@google/adk');

  const fs = await import('fs/promises');
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);

  async function loadAgent(appName) {
    const outPath = path.join(AGENTS_DIR, '.build', `${appName}.cjs`);
    try {
      await fs.access(outPath);
    } catch {
      throw new Error(`Agent not found: ${outPath}. Run npm run build:server first.`);
    }
    const mod = require(outPath);
    const agent = mod.rootAgent || mod.default;
    if (!agent) throw new Error(`No rootAgent in ${appName}`);
    return agent;
  }

  const baseSessionService = new InMemorySessionService();
  const tokenBudget = parseInt(process.env.ADK_CONTEXT_RANK_TOKEN_BUDGET || '4000', 10) || 4000;
  const bufferTokens = parseInt(process.env.ADK_CONTEXT_BUFFER_TOKENS || '2200', 10) || 2200;
  const { createTrimmingSessionService } = await import('./server/trimming-session-service.mjs');
  const sessionService = createTrimmingSessionService(baseSessionService, tokenBudget, bufferTokens);
  const artifactService = new InMemoryArtifactService();
  const memoryService = new InMemoryMemoryService();
  const runnerCache = new Map();
  let lastToolExecutorUrl = process.env.ADK_TOOL_EXECUTOR_URL || '';

  async function getRunner(appName, toolExecutorUrl) {
    if (toolExecutorUrl && toolExecutorUrl !== lastToolExecutorUrl) {
      lastToolExecutorUrl = toolExecutorUrl;
      process.env.ADK_TOOL_EXECUTOR_URL = toolExecutorUrl;
      runnerCache.delete(appName);
    }
    if (runnerCache.has(appName)) return runnerCache.get(appName);
    const agent = await loadAgent(appName);
    const runner = new Runner({
      appName,
      agent,
      sessionService,
      memoryService,
      artifactService,
    });
    runnerCache.set(appName, runner);
    return runner;
  }

  function extractUserMessageText(msg) {
    if (!msg?.parts) return '';
    return msg.parts.map((p) => p?.text ?? '').join('');
  }

  function isTokenLimitError(msg) {
    if (!msg || typeof msg !== 'string') return false;
    const s = msg.toLowerCase();
    return /context\s*length|context_length|prompt\s*too\s*long|token\s*limit|max.*token|exceeded|num_ctx/i.test(s);
  }

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '50mb' }));

  app.get('/list-apps', (_, res) => res.json(['adk_chat']));

  /** Context tools — disabled on Vercel (requires MCP context-strategies). Agent continues without them. */
  app.post('/context-tools', (req, res) => {
    res.status(501).json({ error: 'Context strategies disabled on Vercel deployment' });
  });

  /** Ollama thinking-capable models — proxies to user's ollamaBaseUrl. Works only if Ollama is publicly reachable. */
  app.post('/run_ollama_sse', async (req, res) => {
    const { userMessage, model, ollamaBaseUrl } = req.body || {};
    const base = (ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${base}/api/chat`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'qwen3',
          messages: [{ role: 'user', content: userMessage || '' }],
          stream: true,
          think: true,
        }),
      });
      if (!resp.ok) {
        res.write(`data: ${JSON.stringify({ error: `Ollama error: ${resp.status}` })}\n\n`);
        res.end();
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let thinkingId = 'ollama_thinking_1';
      let thinkingActive = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              const msg = chunk.message || {};
              if (typeof msg.thinking === 'string' && msg.thinking) {
                thinkingActive = true;
                res.write(`data: ${JSON.stringify({ thinking: { text: msg.thinking, id: thinkingId } })}\n\n`);
              }
              if (typeof msg.content === 'string' && msg.content) {
                if (thinkingActive) {
                  res.write(`data: ${JSON.stringify({ thinking: { text: '', id: thinkingId, metadata: { vscodeReasoningDone: true } } })}\n\n`);
                  thinkingActive = false;
                }
                res.write(`data: ${JSON.stringify({ content: { parts: [{ text: msg.content }] } })}\n\n`);
              }
            } catch (_) {}
          }
        }
        if (thinkingActive) {
          res.write(`data: ${JSON.stringify({ thinking: { text: '', id: thinkingId, metadata: { vscodeReasoningDone: true } } })}\n\n`);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.end();
  });

  app.post('/apps/:appName/users/:userId/sessions/:sessionId', async (req, res) => {
    const { appName, userId, sessionId } = req.params;
    const existing = await sessionService.getSession({ appName, userId, sessionId });
    if (existing) return res.status(400).json({ error: 'Session exists' });
    const session = await sessionService.createSession({ appName, userId, sessionId, state: {} });
    res.json(session);
  });

  app.get('/apps/:appName/users/:userId/sessions/:sessionId', async (req, res) => {
    const { appName, userId, sessionId } = req.params;
    const session = await sessionService.getSession({ appName, userId, sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  app.post('/run_sse', async (req, res) => {
    const { appName, userId, sessionId, newMessage, streaming, modelOverride, toolExecutorUrl, contextLimit, retryTrimPercent } = req.body;
    globalThis.__ADK_MODEL_OVERRIDE = modelOverride ?? null;
    globalThis.__ADK_REQUEST_CONTEXT_LIMIT = typeof contextLimit === 'number' && contextLimit > 0 ? contextLimit : null;
    globalThis.__ADK_RETRY_TRIM_PERCENT = typeof retryTrimPercent === 'number' && retryTrimPercent >= 1 && retryTrimPercent <= 100 ? retryTrimPercent : 12.5;

    const session = await sessionService.getSession({ appName, userId, sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (toolExecutorUrl) process.env.ADK_TOOL_EXECUTOR_URL = toolExecutorUrl;

    let messageToRun = newMessage;
    const runner = await getRunner(appName, toolExecutorUrl);

    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let prevText = '';
    let prevThoughtText = '';
    let thinkingActive = false;
    const thinkingId = 'adk_thinking_1';

    try {
      for await (const event of runner.runAsync({
        userId,
        sessionId,
        newMessage: messageToRun,
        runConfig: { streamingMode: streaming ? StreamingMode.SSE : StreamingMode.NONE },
      })) {
        if (event.errorMessage) {
          res.write(`data: ${JSON.stringify({ error: event.errorMessage })}\n\n`);
        } else {
          const parts = event.content?.parts ?? [];
          const thoughtText = parts.filter((p) => p?.thought === true).map((p) => p?.text ?? '').join('');
          const contentText = stringifyContent(event) ?? parts.filter((p) => !p?.thought).map((p) => p?.text ?? '').join('');

          if (thoughtText !== prevThoughtText) {
            const thoughtDelta = thoughtText.startsWith(prevThoughtText) ? thoughtText.slice(prevThoughtText.length) : thoughtText;
            prevThoughtText = thoughtText;
            if (thoughtDelta) {
              thinkingActive = true;
              res.write(`data: ${JSON.stringify({ thinking: { text: thoughtDelta, id: thinkingId, metadata: {} } })}\n\n`);
            }
          }
          if (contentText && thinkingActive) {
            res.write(`data: ${JSON.stringify({ thinking: { text: '', id: thinkingId, metadata: { vscodeReasoningDone: true } } })}\n\n`);
            thinkingActive = false;
          }
          if (contentText !== prevText) {
            const delta = contentText.startsWith(prevText) ? contentText.slice(prevText.length) : contentText;
            prevText = contentText;
            if (delta) res.write(`data: ${JSON.stringify({ content: { parts: [{ text: delta }] } })}\n\n`);
          }
        }
      }
      if (thinkingActive) {
        res.write(`data: ${JSON.stringify({ thinking: { text: '', id: thinkingId, metadata: { vscodeReasoningDone: true } } })}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
      globalThis.__ADK_MODEL_OVERRIDE = null;
      globalThis.__ADK_REQUEST_CONTEXT_LIMIT = null;
      globalThis.__ADK_RETRY_TRIM_PERCENT = null;
    }
    res.end();
  });

  return app;
}
