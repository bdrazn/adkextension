#!/usr/bin/env node
/**
 * Copy server + agents to api/ for Vercel deployment.
 * The server runs as a serverless function.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployDir = path.resolve(__dirname, '..');
const root = path.resolve(deployDir, '..');
const extensionDir = path.join(root, 'extension');
const apiDir = path.join(deployDir, 'api');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === 'node_modules' || name === '.build') continue;
      if (name.endsWith('.bundle.mjs') || name.endsWith('.bundle.cjs')) continue; // skip — Vercel path conflict
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.mkdirSync(apiDir, { recursive: true });

const serverSrc = path.join(extensionDir, 'server');
const agentsBuild = path.join(extensionDir, 'agents', '.build');

if (!fs.existsSync(serverSrc) || !fs.existsSync(agentsBuild)) {
  console.error('Error: extension/server and extension/agents/.build must exist.');
  console.error('Run from project root with extension/ as sibling.');
  process.exit(1);
}

// Copy server files (api/server and api/agents are gitignored — your code stays local)
const serverDest = path.join(apiDir, 'server');
const agentsDest = path.join(apiDir, 'agents', '.build');

fs.rmSync(serverDest, { recursive: true, force: true });
copyRecursive(serverSrc, serverDest);
console.log('Copied server/');

fs.mkdirSync(path.dirname(agentsDest), { recursive: true });
fs.rmSync(agentsDest, { recursive: true, force: true });
copyRecursive(agentsBuild, agentsDest);
console.log('Copied agents/.build/');

console.log('Vercel server files ready in api/ (api/server and api/agents are gitignored — not committed)');
