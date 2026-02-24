/**
 * Context tools executor — runs context-strategies tools for the agent.
 * Shares init with context-middleware via context-shared.
 */
import { ensureInitialized, getAssociative, getStuck, getPriority } from './context-shared.mjs';

const ChatMessageRole = { System: 0, User: 1, Assistant: 2 };

function parseRole(r) {
  if (r === 0 || r === 1 || r === 2) return r;
  if (typeof r === 'string') {
    const s = r.toLowerCase();
    if (s === 'system') return 0;
    if (s === 'user') return 1;
    if (s === 'assistant') return 2;
  }
  return 1;
}

function normalizeMessage(m) {
  if (!m || !m.content) return null;
  const content = Array.isArray(m.content)
    ? m.content.map((p) => (typeof p === 'object' && p !== null ? { type: p.type || 'text', value: p.value ?? p.text ?? '' } : { type: 'text', value: String(p) }))
    : [{ type: 'text', value: String(m.content) }];
  return { role: parseRole(m.role), content };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeMessage).filter(Boolean);
}

function estimateMessageTokens(msg) {
  const text = (msg.content || [])
    .map((p) => (p?.type === 'text' || p?.type === 'thinking' ? (Array.isArray(p.value) ? p.value.join('\n') : String(p.value ?? '')) : ''))
    .join('\n');
  return Math.ceil(text.length / 4);
}


/**
 * Execute a context tool by name. Returns JSON-serializable result.
 */
export async function executeTool(name, args = {}) {
  if (!process.env.ADK_ENABLE_CONTEXT_STRATEGIES || process.env.ADK_ENABLE_CONTEXT_STRATEGIES === '0') {
    return { error: 'Context strategies disabled' };
  }
  await ensureInitialized();
  const associative = getAssociative();
  const stuck = getStuck();
  const priority = getPriority();
  if (!associative || !stuck || !priority) {
    return { error: 'Context tools not initialized' };
  }

  try {
    switch (name) {
      case 'context_associative_sieve': {
        const query = args.query || '';
        const tokenBudget = typeof args.tokenBudget === 'number' ? args.tokenBudget : 2000;
        await associative.initialize();
        const r = await associative.sieve(query, tokenBudget, args.options || {});
        return {
          context: r.context,
          nodesIncluded: r.nodesIncluded,
          tokensUsed: r.tokensUsed,
          topNodes: r.topNodes ? r.topNodes.map((n) => ({ id: n.id, category: n.category, activation: n.activation, summary: n.summary })) : [],
          categoriesRepresented: r.categoriesRepresented || [],
        };
      }
      case 'context_associative_ingest': {
        const { content, category, subcategory, source, tags } = args;
        if (!content) return { error: 'content is required' };
        await associative.initialize();
        const node = await associative.ingest(content, category, subcategory, source, tags || []);
        return { node: { id: node.id, category: node.category, subcategory: node.subcategory, source: node.metadata?.source }, stats: associative.getStats() };
      }
      case 'context_associative_ingest_batch': {
        const items = args.items || [];
        await associative.initialize();
        const nodes = await associative.ingestBatch(items);
        return { count: nodes.length, stats: associative.getStats() };
      }
      case 'context_associative_stats': {
        await associative.initialize();
        return associative.getStats();
      }
      case 'context_associative_clear': {
        await associative.initialize();
        await associative.clear();
        await associative.persist();
        return { ok: true, message: 'Associative memory cleared' };
      }
      case 'context_associative_record_outcome': {
        const outcome = args.outcome;
        if (!['success', 'failure', 'partial'].includes(outcome)) return { error: 'outcome must be success, failure, or partial' };
        await associative.initialize();
        await associative.recordTaskOutcome(outcome);
        return { outcome, stats: associative.getStats() };
      }
      case 'context_detect_stuck': {
        const messages = normalizeMessages(args.messages || []);
        if (messages.length < 2) return { result: { isStuck: false, type: 'none', confidence: 0, evidence: [], suggestedAction: '' }, recoveryMessage: null };
        const result = stuck.detectStuck(messages);
        const recoveryMessage = args.includeRecoveryMessage ? stuck.generateRecoveryMessage(result) : null;
        const recContent = recoveryMessage?.content?.[0];
        return {
          result: {
            isStuck: result.isStuck,
            type: result.type,
            confidence: result.confidence,
            evidence: result.evidence || [],
            suggestedAction: result.suggestedAction || '',
          },
          recoveryMessage: recContent ? (recContent.value ?? recContent.text ?? '') : null,
        };
      }
      case 'context_rank_messages': {
        const messages = normalizeMessages(args.messages || []);
        if (messages.length === 0) return { totalMessages: 0, ranked: [], selectedCount: 0, selected: [] };
        const ranked = priority.sortByPriority(messages);
        const tokenBudget = args.tokenBudget;
        const topN = args.topN;
        const selected =
          typeof tokenBudget === 'number'
            ? priority.selectByTokenBudget(messages, tokenBudget, estimateMessageTokens)
            : typeof topN === 'number'
              ? priority.selectTopMessages(messages, topN)
              : messages;
        return {
          totalMessages: messages.length,
          ranked: ranked.map((r) => ({ score: r.score, reasons: r.reasons })),
          selectedCount: selected.length,
          selected: selected.map((m) => ({ role: m.role, content: m.content })),
        };
      }
      case 'context_health': {
        await associative.initialize();
        return { associative: associative.getStats(), ok: true };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}
