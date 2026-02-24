/**
 * Shared context-strategies state — single init for middleware and agent tools.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = {
  trace: () => {},
  debug: (m, d) => console.error('[context]', m, d ?? ''),
  info: (m, d) => console.error('[context]', m, d ?? ''),
  warn: (m, d) => console.error('[context]', m, d ?? ''),
  error: (m, d) => console.error('[context]', m, d ?? ''),
};

let associative = null;
let stuck = null;
let priority = null;
let initPromise = null;

export async function ensureInitialized() {
  if (associative && stuck && priority) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const core = await import('context-strategies-vercel-mcp/core');
      const { FileStorageAdapter } = await import('context-strategies-vercel-mcp/storage');
      const storagePath = path.join(__dirname, '..', '.context-strategies-associative.json');
      const storage = new FileStorageAdapter(storagePath);
      associative = new core.AssociativeSieve(logger, new core.SimpleEmbeddingService(), storage);
      stuck = new core.StuckDetector(logger);
      priority = new core.MessagePriorityCalculator();
      await associative.initialize();
    } catch (err) {
      console.error('[context] Init failed:', err);
      associative = null;
      stuck = null;
      priority = null;
    }
  })();
  return initPromise;
}

export function getAssociative() {
  return associative;
}

export function getStuck() {
  return stuck;
}

export function getPriority() {
  return priority;
}
