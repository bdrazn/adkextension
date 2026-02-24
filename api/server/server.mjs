#!/usr/bin/env node
/**
 * ADK server — runs inside the extension. Spawned by extension on activation.
 * Env vars (OPENAI_COMPATIBLE_*) are passed by the extension.
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Runner,
  InMemorySessionService,
  InMemoryMemoryService,
  InMemoryArtifactService,
  StreamingMode,
  stringifyContent,
} from '@google/adk';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, '..', 'agents');

async function loadAgent(appName) {
  const outPath = path.join(AGENTS_DIR, '.build', `${appName}.cjs`);
  const prebuiltExists = await fs.access(outPath).then(() => true).catch(() => false);

  if (prebuiltExists) {
    const { createRequire } = await import('module');
    const mod = createRequire(import.meta.url)(path.resolve(outPath));
    const agent = mod.rootAgent || mod.default;
    if (!agent) throw new Error(`No rootAgent in ${appName}`);
    return agent;
  }

  // Dev fallback: build on the fly (requires esbuild in node_modules)
  const esbuild = (await import('esbuild')).default;
  const agentPath = path.join(AGENTS_DIR, appName, 'agent.ts');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await esbuild.build({
    entryPoints: [agentPath],
    outfile: outPath,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'bundle',
  });
  const { createRequire } = await import('module');
  const mod = createRequire(import.meta.url)(path.resolve(outPath));
  const agent = mod.rootAgent || mod.default;
  if (!agent) throw new Error(`No rootAgent in ${appName}`);
  return agent;
}

const baseSessionService = new InMemorySessionService();
const tokenBudget = parseInt(process.env.ADK_CONTEXT_RANK_TOKEN_BUDGET || '4000', 10) || 4000;
const bufferTokens = parseInt(process.env.ADK_CONTEXT_BUFFER_TOKENS || '2200', 10) || 2200;
const compactionInterval = parseInt(process.env.ADK_COMPACTION_INTERVAL || '3', 10) || 3;
const compactionOverlap = parseInt(process.env.ADK_COMPACTION_OVERLAP || '1', 10) || 1;

let sessionService = baseSessionService;

if (process.env.ADK_ENABLE_COMPACTION === '1') {
  const { createLlmEventSummarizer } = await import('./llm-event-summarizer.mjs');
  const { summarizerLlm } = await import('./summarizer-llm.mjs');
  const { createCompactingSessionService } = await import('./compacting-session-service.mjs');
  const summarizer = createLlmEventSummarizer(summarizerLlm);
  sessionService = createCompactingSessionService(baseSessionService, {
    summarizer,
    compactionInterval,
    overlapSize: compactionOverlap,
    minEventsToCompact: compactionInterval * 2,
    storageRef: { sessions: baseSessionService.sessions },
  });
}

// Always apply trimming to prevent "prompt too long" errors (uses FIFO fallback when context strategies unavailable)
const { createTrimmingSessionService } = await import('./trimming-session-service.mjs');
sessionService = createTrimmingSessionService(sessionService, tokenBudget, bufferTokens);
const artifactService = new InMemoryArtifactService();
const memoryService = new InMemoryMemoryService();
const runnerCache = new Map();
let lastToolExecutorUrl = process.env.ADK_TOOL_EXECUTOR_URL || '';

async function getRunner(appName, toolExecutorUrl) {
  if (toolExecutorUrl && toolExecutorUrl !== lastToolExecutorUrl) {
    lastToolExecutorUrl = toolExecutorUrl;
    process.env.ADK_TOOL_EXECUTOR_URL = toolExecutorUrl;
    runnerCache.delete(appName);
  } else if (toolExecutorUrl) {
    process.env.ADK_TOOL_EXECUTOR_URL = toolExecutorUrl;
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

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

app.get('/list-apps', (_, res) => res.json(['adk_chat']));

/** Context tools endpoint — for agent tools when using HTTP executor (optional) */
app.post('/context-tools', async (req, res) => {
  const { tool, args } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool is required' });
  try {
    const { executeTool } = await import('./context-tools-executor.mjs');
    const result = await executeTool(tool, args || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
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

/** Ollama thinking-capable models (deepseek-r1, qwen3, etc.) */
const OLLAMA_THINKING_MODELS = new Set(['deepseek-r1', 'deepseek-r1:latest', 'qwen3', 'qwen3:latest', 'gpt-oss', 'gpt-oss:latest', 'deepseek-v3.1', 'deepseek-v3.1:latest']);

function isOllamaWithThinking(baseUrl, model) {
  const u = baseUrl?.replace(/\/$/, '');
  const isOllama = u?.includes('11434') || u === 'http://localhost:11434' || u?.endsWith('/v1') && (u?.includes('11434') || u === 'http://localhost:11434/v1');
  const modelName = (model || '').split(':')[0];
  return isOllama && (OLLAMA_THINKING_MODELS.has(model) || OLLAMA_THINKING_MODELS.has(modelName));
}

app.post('/run_ollama_sse', async (req, res) => {
  const { userMessage, model, ollamaBaseUrl } = req.body;
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
        messages: [{ role: 'user', content: userMessage }],
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

function extractUserMessageText(msg) {
  if (!msg?.parts) return '';
  return msg.parts.map((p) => p?.text ?? '').join('');
}

/** Detect if error message indicates token/context limit exceeded. */
function isTokenLimitError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const s = msg.toLowerCase();
  return (
    /context\s*length|context_length|prompt\s*too\s*long|token\s*limit|max.*token|maximum\s*context|exceeded|num_ctx|input.*length/i.test(s) ||
    /too many tokens|token count|context window/i.test(s)
  );
}

/** Run summarise (aggressive trim) before retry. Sets budget factor for next getSession. Uses retryTrimPercent from request; context strategies preserve higher-priority messages. */
function runSummariseOnTokenError() {
  const pct = typeof globalThis.__ADK_RETRY_TRIM_PERCENT === 'number' ? globalThis.__ADK_RETRY_TRIM_PERCENT : 12.5;
  globalThis.__ADK_RETRY_TOKEN_BUDGET_FACTOR = pct / 100;
}

app.post('/run_sse', async (req, res) => {
  const { appName, userId, sessionId, newMessage, streaming, modelOverride, toolExecutorUrl, contextLimit, retryTrimPercent } = req.body;
  globalThis.__ADK_MODEL_OVERRIDE = modelOverride ?? null;
  globalThis.__ADK_REQUEST_CONTEXT_LIMIT = typeof contextLimit === 'number' && contextLimit > 0 ? contextLimit : null;
  globalThis.__ADK_RETRY_TRIM_PERCENT = typeof retryTrimPercent === 'number' && retryTrimPercent >= 1 && retryTrimPercent <= 100 ? retryTrimPercent : 12.5;
  const session = await sessionService.getSession({ appName, userId, sessionId });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (toolExecutorUrl) process.env.ADK_TOOL_EXECUTOR_URL = toolExecutorUrl;

  let messageToRun = newMessage;
  if (process.env.ADK_ENABLE_CONTEXT_STRATEGIES === '1') {
    try {
      const { runBeforeRequest } = await import('./context-middleware.mjs');
      const { enrichedUserMessage, recoveryMessage } = await runBeforeRequest(session, newMessage);
      if (recoveryMessage) {
        messageToRun = {
          role: 'user',
          parts: [{ text: `${recoveryMessage}\n\n[User message]\n${extractUserMessageText(newMessage)}` }],
        };
      } else if (enrichedUserMessage) {
        messageToRun = enrichedUserMessage;
      }
    } catch (err) {
      console.error('[context] runBeforeRequest failed:', err);
    }
  }

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
  const userMessageText = extractUserMessageText(newMessage);
  let tokenErrorRetried = false;

  async function runLoop() {
    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage: messageToRun,
      runConfig: { streamingMode: streaming ? StreamingMode.SSE : StreamingMode.NONE },
    })) {
      if (event.errorMessage) {
        if (isTokenLimitError(event.errorMessage) && !tokenErrorRetried) {
          tokenErrorRetried = true;
          runSummariseOnTokenError();
          prevText = '';
          prevThoughtText = '';
          thinkingActive = false;
          console.log('[run_sse] Token limit hit, summarising and retrying…');
          return 'retry';
        }
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
          if (delta) {
            res.write(`data: ${JSON.stringify({ content: { parts: [{ text: delta }] } })}\n\n`);
          }
        }
      }
    }
    if (thinkingActive) {
      res.write(`data: ${JSON.stringify({ thinking: { text: '', id: thinkingId, metadata: { vscodeReasoningDone: true } } })}\n\n`);
    }
    return 'done';
  }

  try {
    let status = await runLoop();
    if (status === 'retry') {
      prevText = '';
      await runLoop();
    }
  } catch (err) {
    if (isTokenLimitError(err.message) && !tokenErrorRetried) {
      tokenErrorRetried = true;
      runSummariseOnTokenError();
      prevText = '';
      console.log('[run_sse] Token limit error (thrown), summarising and retrying…');
      try {
        await runLoop();
      } catch (retryErr) {
        console.error('run_sse retry error:', retryErr);
        res.write(`data: ${JSON.stringify({ error: retryErr.message })}\n\n`);
      }
    } else {
      console.error('run_sse error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  } finally {
    globalThis.__ADK_MODEL_OVERRIDE = null;
    globalThis.__ADK_REQUEST_CONTEXT_LIMIT = null;
    globalThis.__ADK_RETRY_TRIM_PERCENT = null;
    globalThis.__ADK_RETRY_TOKEN_BUDGET_FACTOR = null;
    if (process.env.ADK_ENABLE_CONTEXT_STRATEGIES === '1' && prevText) {
      import('./context-middleware.mjs')
        .then(({ runAfterResponse }) => runAfterResponse(session, userMessageText, prevText))
        .catch((e) => console.error('[context] runAfterResponse failed:', e));
    }
  }
  res.end();
});

const basePort = parseInt(process.env.ADK_PORT || '8000', 10);
const portRange = [basePort, ...Array.from({ length: 5 }, (_, i) => basePort + 1 + i)].slice(0, 6);
const portFile = process.env.ADK_PORT_FILE;

function tryListen(portIndex) {
  if (portIndex >= portRange.length) {
    console.error('Server error: Could not bind to any port in', portRange);
    process.exit(1);
  }
  const port = portRange[portIndex];
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`ADK server listening on 127.0.0.1:${port}`);
    if (portFile) {
      import('fs').then(({ default: fs }) => fs.promises.writeFile(portFile, String(port)));
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      tryListen(portIndex + 1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

tryListen(0);
