/**
 * CompactingSessionService — port of Python ADK's EventsCompactionConfig + SlidingWindowCompactor.
 * Wraps a session service and compacts events using LlmEventSummarizer when compaction_interval is reached.
 * Compaction runs after appendEvent and persists to the inner store (when inner exposes mutable sessions).
 * @see https://google.github.io/adk-docs/context/compaction/
 * @see https://github.com/google/adk-python EventsCompactionConfig, LlmEventSummarizer
 */

import { createEvent, createEventActions } from '@google/adk';

function createNewEventId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

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

/**
 * Create a summary event that replaces a range of events.
 * Stored as a user message so the LLM sees it as context.
 */
function createSummaryEvent(summary, startTimestamp, endTimestamp) {
  return createEvent({
    id: `compaction_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    invocationId: createNewEventId(),
    author: 'user',
    timestamp: endTimestamp,
    content: {
      role: 'user',
      parts: [{ text: `[Previous conversation summary]\n${summary}` }],
    },
    actions: createEventActions(),
  });
}

/**
 * Apply sliding-window compaction to events.
 * Python logic: every compaction_interval events, compact the prior window including overlap_size from previous.
 */
function computeCompactionWindow(events, compactionInterval, overlapSize) {
  const n = events.length;
  if (n < compactionInterval) return null;

  const numFullWindows = Math.floor(n / compactionInterval);
  if (numFullWindows === 0) return null;

  const windowEnd = numFullWindows * compactionInterval;
  const overlapStart = Math.max(0, windowEnd - compactionInterval - overlapSize);
  return { start: overlapStart, end: windowEnd };
}

/**
 * Run compaction on events and return compacted array, or null if no compaction.
 */
async function runCompaction(events, summarizer, compactionInterval, overlapSize, minEventsToCompact) {
  const window = computeCompactionWindow(events, compactionInterval, overlapSize);
  if (!window || window.end - window.start < minEventsToCompact) return null;

  const toCompact = events.slice(window.start, window.end);
  if (toCompact.length === 0) return null;

  const result = await summarizer.maybeSummarizeEvents(toCompact);
  if (!result) return null;

  const summaryText = result.content?.parts
    ?.map((p) => p?.text ?? '')
    .join('\n')
    .trim();
  if (!summaryText) return null;

  const summaryEvent = createSummaryEvent(
    summaryText,
    result.startTimestamp,
    result.endTimestamp
  );

  const before = events.slice(0, window.start);
  const after = events.slice(window.end);
  return [...before, summaryEvent, ...after];
}

/**
 * Creates a session service that compacts events when they exceed the threshold.
 * Works with InMemorySessionService: compacts in getSession and optionally persists
 * when inner exposes a sessions map (e.g. InMemorySessionService).
 *
 * @param {Object} inner - Base session service
 * @param {Object} opts - Compaction options
 * @param {Object} opts.summarizer - LlmEventSummarizer (from createLlmEventSummarizer)
 * @param {number} [opts.compactionInterval=3] - Trigger compaction every N events
 * @param {number} [opts.overlapSize=1] - Include N prior events in each compaction window
 * @param {number} [opts.minEventsToCompact=6] - Minimum events before first compaction
 * @param {Object} [opts.storageRef] - If provided, { sessions } to persist compacted events (InMemorySessionService.sessions)
 */
export function createCompactingSessionService(inner, opts = {}) {
  const {
    summarizer,
    compactionInterval = 3,
    overlapSize = 1,
    minEventsToCompact = 6,
    storageRef,
  } = opts;

  if (!summarizer) {
    throw new Error('CompactingSessionService requires summarizer');
  }

  const maybePersistCompaction = (appName, userId, sessionId, compactedEvents) => {
    if (!storageRef?.sessions?.[appName]?.[userId]?.[sessionId]) return;
    storageRef.sessions[appName][userId][sessionId].events = compactedEvents;
  };

  return {
    async createSession(req) {
      return inner.createSession(req);
    },

    async getSession(req) {
      const session = await inner.getSession(req);
      if (!session?.events?.length) return session;

      const events = [...session.events];

      try {
        const compacted = await runCompaction(
          events,
          summarizer,
          compactionInterval,
          overlapSize,
          minEventsToCompact
        );
        if (!compacted) return session;

        if (storageRef?.sessions) {
          maybePersistCompaction(req.appName, req.userId, req.sessionId, compacted);
        }

        return { ...session, events: compacted };
      } catch (err) {
        console.error('[CompactingSessionService] compaction failed:', err);
        return session;
      }
    },

    async listSessions(req) {
      return inner.listSessions(req);
    },

    async deleteSession(req) {
      return inner.deleteSession(req);
    },

    async appendEvent(req) {
      const event = await inner.appendEvent(req);
      const session = req.session;
      if (!session?.appName || !session?.userId || !session?.id) return event;
      if (!storageRef?.sessions) return event;

      const storageSession = storageRef.sessions[session.appName]?.[session.userId]?.[session.id];
      if (!storageSession?.events?.length) return event;

      try {
        const compacted = await runCompaction(
          storageSession.events,
          summarizer,
          compactionInterval,
          overlapSize,
          minEventsToCompact
        );
        if (compacted) {
          storageSession.events = compacted;
        }
      } catch (err) {
        console.error('[CompactingSessionService] post-append compaction failed:', err);
      }
      return event;
    },
  };
}
