/**
 * LlmEventSummarizer — port of Python ADK's LlmEventSummarizer.
 * Summarizes a list of session events into a single compacted event using an LLM.
 * @see https://github.com/google/adk-python/blob/main/src/google/adk/apps/llm_event_summarizer.py
 */

const DEFAULT_PROMPT_TEMPLATE =
  'The following is a conversation history between a user and an AI agent. Please summarize the conversation, focusing on key information and decisions made, as well as any unresolved questions or tasks. The summary should be concise and capture the essence of the interaction.\n\n{conversation_history}';

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      if (!p) return '';
      if (p.text) return String(p.text);
      if (p.value !== undefined) return String(p.value);
      return '';
    })
    .join('');
}

function formatEventsForPrompt(events) {
  const lines = [];
  for (const ev of events) {
    if (ev?.content?.parts) {
      const text = extractTextFromParts(ev.content.parts);
      if (text.trim()) {
        const author = ev.author || 'user';
        lines.push(`${author}: ${text}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Creates an LlmEventSummarizer that uses the given LLM to summarize events.
 * @param {Object} llm - BaseLlm instance (e.g. OpenAICompatibleLlm) with generateContentAsync
 * @param {string} [promptTemplate] - Template with {conversation_history} placeholder
 */
export function createLlmEventSummarizer(llm, promptTemplate = DEFAULT_PROMPT_TEMPLATE) {
  return {
    /**
     * Summarize events and return compacted content, or null if nothing to summarize.
     * @param {Array} events - Session events to compact
     * @returns {Promise<{ content: { role: string; parts: Array<{ text: string }> }; startTimestamp: number; endTimestamp: number } | null>}
     */
    async maybeSummarizeEvents(events) {
      if (!events?.length) return null;

      const conversationHistory = formatEventsForPrompt(events);
      if (!conversationHistory.trim()) return null;

      const prompt = promptTemplate.replace('{conversation_history}', conversationHistory);

      const llmRequest = {
        model: llm.model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
      };

      let summaryContent = null;
      for await (const response of llm.generateContentAsync(llmRequest, false)) {
        if (response.errorCode) {
          console.error('[LlmEventSummarizer] LLM error:', response.errorCode, response.errorMessage);
          return null;
        }
        if (response.content?.parts?.length) {
          summaryContent = response.content;
          break;
        }
      }

      if (!summaryContent) return null;

      const startTimestamp = events[0]?.timestamp ?? Date.now() / 1000;
      const endTimestamp = events[events.length - 1]?.timestamp ?? Date.now() / 1000;

      return {
        content: { ...summaryContent, role: 'model' },
        startTimestamp,
        endTimestamp,
      };
    },
  };
}
