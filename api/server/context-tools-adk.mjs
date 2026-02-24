/**
 * ADK FunctionTools for context-strategies. Call executeTool in-process.
 */
import { FunctionTool } from '@google/adk';
import { executeTool } from './context-tools-executor.mjs';

function makeTool(name, description, parameters, argKeys) {
  return new FunctionTool({
    name,
    description,
    parameters,
    execute: async (input) => {
      const args = {};
      for (const k of argKeys) {
        if (input && k in input) args[k] = input[k];
      }
      const result = await executeTool(name, args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  });
}

export function createContextTools() {
  return [
    makeTool(
      'context_associative_sieve',
      'Retrieve relevant memories by semantic search. Use when you need prior context about a topic. Pass query (string) and optional tokenBudget (number).',
      { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, tokenBudget: { type: 'number', description: 'Max tokens to return' } }, required: ['query'] },
      ['query', 'tokenBudget']
    ),
    makeTool(
      'context_associative_ingest',
      'Store a memory for later recall. Use after important decisions, patterns, or learnings. Pass content (string), optional category (code|pattern|decision|error|tool), source, tags.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Content to store' },
          category: { type: 'string', enum: ['code', 'pattern', 'decision', 'error', 'tool'] },
          source: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content'],
      },
      ['content', 'category', 'subcategory', 'source', 'tags']
    ),
    makeTool(
      'context_associative_ingest_batch',
      'Store multiple memories at once. Pass items: [{content, category?, source?, tags?}].',
      {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, category: { type: 'string' }, source: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['content'] } } },
        required: ['items'],
      },
      ['items']
    ),
    makeTool(
      'context_associative_stats',
      'Get associative memory statistics (node count, etc).',
      { type: 'object', properties: {} },
      []
    ),
    makeTool(
      'context_associative_clear',
      'Clear all associative memory. Use with caution.',
      { type: 'object', properties: {} },
      []
    ),
    makeTool(
      'context_associative_record_outcome',
      'Record task outcome (success, failure, partial) for learning.',
      { type: 'object', properties: { outcome: { type: 'string', enum: ['success', 'failure', 'partial'] } }, required: ['outcome'] },
      ['outcome']
    ),
    makeTool(
      'context_detect_stuck',
      'Detect if the conversation is stuck in a loop. Pass messages: [{role: user|assistant|system, content: string|[{type,value}]}], optional includeRecoveryMessage: true.',
      {
        type: 'object',
        properties: {
          messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: {} } } },
          includeRecoveryMessage: { type: 'boolean' },
        },
        required: ['messages'],
      },
      ['messages', 'includeRecoveryMessage']
    ),
    makeTool(
      'context_rank_messages',
      'Rank messages by importance for context window. Pass messages, optional topN or tokenBudget.',
      {
        type: 'object',
        properties: {
          messages: { type: 'array', items: { type: 'object' } },
          topN: { type: 'number' },
          tokenBudget: { type: 'number' },
        },
        required: ['messages'],
      },
      ['messages', 'topN', 'tokenBudget']
    ),
    makeTool('context_health', 'Check context system health.', { type: 'object', properties: {} }, []),
  ];
}
