/**
 * Session service wrapper that trims events by context_rank_messages when over budget.
 * Used when ADK_ENABLE_CONTEXT_STRATEGIES=1.
 */
import { ensureInitialized, getPriority } from './context-shared.mjs';

const ChatMessageRole = { System: 0, User: 1, Assistant: 2 };

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      if (!p) return '';
      if (p.text) return String(p.text);
      if (p.value !== undefined) return String(p.value);
      if (p.inlineData) return '[binary]';
      return '';
    })
    .join('');
}

function eventsToMessagesWithIndices(events) {
  const messages = [];
  const eventIndices = [];
  for (let i = 0; i < (events || []).length; i++) {
    const ev = events[i];
    const text = extractTextFromParts(ev?.content?.parts);
    if (!text.trim()) continue;
    const author = (ev.author || '').toLowerCase();
    let role = ChatMessageRole.User;
    if (author === 'user' || author === '') role = ChatMessageRole.User;
    else role = ChatMessageRole.Assistant;
    messages.push({ role, content: [{ type: 'text', value: text }] });
    eventIndices.push(i);
  }
  return { messages, eventIndices };
}

function estimateMessageTokens(msg) {
  const text = (msg.content || [])
    .map((p) => (p?.type === 'text' || p?.type === 'thinking' ? (Array.isArray(p.value) ? p.value.join('\n') : String(p.value ?? '')) : ''))
    .join('\n');
  return Math.ceil(text.length / 4);
}

/**
 * Trim events to fit token budget using context_rank_messages.
 * Returns trimmed events array (subset of original, preserving order by priority).
 */
function trimEventsByRank(events, tokenBudget) {
  if (!events || events.length === 0) return events;
  const { messages, eventIndices } = eventsToMessagesWithIndices(events);
  if (messages.length === 0) return events;
  if (messages.length <= 3) return events;

  const priority = getPriority();
  if (!priority) return events;

  const ranked = priority.sortByPriority(messages);
  const selected = priority.selectByTokenBudget(messages, tokenBudget, estimateMessageTokens);

  const indicesToKeep = [];
  for (const msg of selected) {
    const j = messages.indexOf(msg);
    if (j >= 0) indicesToKeep.push(eventIndices[j]);
  }
  indicesToKeep.sort((a, b) => a - b);
  return indicesToKeep.map((i) => events[i]);
}

/** Reserve tokens for system prompt, tools, attachments, and new message. */
const DEFAULT_BUFFER = 2200;

/**
 * Simple FIFO truncation: keep most recent events that fit token budget.
 * Fallback when priority-based trimming is unavailable.
 */
function trimEventsFifo(events, tokenBudget) {
  if (!events || events.length === 0) return events;
  let total = 0;
  const result = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const tokens = Math.ceil((extractTextFromParts(ev?.content?.parts) || '').length / 4);
    if (total + tokens > tokenBudget && result.length > 0) break;
    result.unshift(ev);
    total += tokens;
  }
  return result;
}

/**
 * Wraps a session service and trims events when over token budget.
 * Uses (tokenBudget - buffer) for history to avoid exceeding model context.
 */
export function createTrimmingSessionService(inner, tokenBudget = 4000, bufferTokens = DEFAULT_BUFFER) {
  const defaultBudget = typeof tokenBudget === 'number' ? tokenBudget : 4000;
  const buffer = typeof bufferTokens === 'number' ? bufferTokens : DEFAULT_BUFFER;

  return {
    async createSession(req) {
      return inner.createSession(req);
    },
    async getSession(req) {
      const session = await inner.getSession(req);
      if (!session || !session.events) return session;
      if (session.events.length < 4) return session;

      const budget = typeof globalThis.__ADK_REQUEST_CONTEXT_LIMIT === 'number' && globalThis.__ADK_REQUEST_CONTEXT_LIMIT > 0
        ? globalThis.__ADK_REQUEST_CONTEXT_LIMIT
        : defaultBudget;
      const retryFactor = typeof globalThis.__ADK_RETRY_TOKEN_BUDGET_FACTOR === 'number' && globalThis.__ADK_RETRY_TOKEN_BUDGET_FACTOR > 0
        ? globalThis.__ADK_RETRY_TOKEN_BUDGET_FACTOR
        : 1;
      const effectiveBudget = Math.max(1000, (budget - buffer) * retryFactor);

      const estimatedTokens = session.events.reduce((sum, ev) => {
        const text = extractTextFromParts(ev?.content?.parts);
        return sum + Math.ceil(text.length / 4);
      }, 0);
      if (estimatedTokens <= effectiveBudget) return session;

      try {
        await ensureInitialized();
        const trimmed = trimEventsByRank(session.events, effectiveBudget);
        const finalEvents = trimmed.length < session.events.length ? trimmed : trimEventsFifo(session.events, effectiveBudget);
        if (finalEvents.length >= session.events.length) return session;
        return { ...session, events: [...finalEvents] };
      } catch (err) {
        console.error('[context] trimEventsByRank failed:', err);
        const fallback = trimEventsFifo(session.events, effectiveBudget);
        return fallback.length < session.events.length ? { ...session, events: fallback } : session;
      }
    },
    async listSessions(req) {
      return inner.listSessions(req);
    },
    async deleteSession(req) {
      return inner.deleteSession(req);
    },
    async appendEvent(req) {
      return inner.appendEvent(req);
    },
  };
}
