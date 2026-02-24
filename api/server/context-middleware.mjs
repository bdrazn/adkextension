/**
 * Context strategies middleware — infuses vercel-mcp context management into ADK.
 * Runs when ADK_ENABLE_CONTEXT_STRATEGIES=1.
 */
import { ensureInitialized, getAssociative, getStuck } from './context-shared.mjs';

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

/**
 * Convert ADK session events to ChatMessage[] for context tools.
 */
function eventsToMessages(events) {
  const messages = [];
  for (const ev of events || []) {
    const text = extractTextFromParts(ev.content?.parts);
    if (!text.trim()) continue;
    const author = (ev.author || '').toLowerCase();
    let role = ChatMessageRole.User;
    if (author === 'user' || author === '') role = ChatMessageRole.User;
    else role = ChatMessageRole.Assistant;
    messages.push({
      role,
      content: [{ type: 'text', value: text }],
    });
  }
  return messages;
}


/**
 * Run before each agent request. Returns { enrichedUserMessage, recoveryMessage? }.
 */
export async function runBeforeRequest(session, newMessage) {
  if (!process.env.ADK_ENABLE_CONTEXT_STRATEGIES || process.env.ADK_ENABLE_CONTEXT_STRATEGIES === '0') {
    return { enrichedUserMessage: null, recoveryMessage: null };
  }
  await ensureInitialized();
  const associative = getAssociative();
  const stuck = getStuck();
  if (!associative || !stuck) return { enrichedUserMessage: null, recoveryMessage: null };

  const events = session?.events || [];
  const messages = eventsToMessages(events);
  const userText = extractTextFromParts(newMessage?.parts || []);

  // Append current user message for stuck detection
  if (userText) {
    messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: userText }] });
  }

  // 1. Stuck detection
  const stuckResult = stuck.detectStuck(messages);
  if (stuckResult.isStuck && stuckResult.confidence > 0.6) {
    const recovery = stuck.generateRecoveryMessage(stuckResult);
    const recoveryText = recovery.content?.[0]?.value ?? recovery.content?.[0]?.text ?? '';
    return {
      enrichedUserMessage: null,
      recoveryMessage: recoveryText,
    };
  }

  // 2. Sieve for relevant associative context
  const query = userText || (messages.length ? extractTextFromParts(messages[messages.length - 1]?.content) : '') || 'general';
  const sieveResult = await associative.sieve(query, 1500);
  if (sieveResult.context && sieveResult.nodesIncluded > 0) {
    const prefix = `[Relevant context from memory]\n${sieveResult.context}\n\n`;
    const existingText = userText;
    return {
      enrichedUserMessage: {
        role: 'user',
        parts: [{ text: prefix + existingText }],
      },
      recoveryMessage: null,
    };
  }

  return { enrichedUserMessage: null, recoveryMessage: null };
}

/**
 * Run after each agent response. Ingests key findings into associative memory.
 */
export async function runAfterResponse(session, userMessageText, assistantResponseText) {
  if (!process.env.ADK_ENABLE_CONTEXT_STRATEGIES || process.env.ADK_ENABLE_CONTEXT_STRATEGIES === '0') {
    return;
  }
  await ensureInitialized();
  const associative = getAssociative();
  if (!associative) return;

  try {
    // Ingest a condensed summary of the exchange
    const summary = `User asked: ${(userMessageText || '').slice(0, 200)}. Assistant responded: ${(assistantResponseText || '').slice(0, 500)}`;
    if (summary.length > 50) {
      await associative.ingest(summary, 'decision', undefined, 'adk_chat', ['exchange']);
    }
  } catch (err) {
    console.error('[context] Ingest failed', err);
  }
}
