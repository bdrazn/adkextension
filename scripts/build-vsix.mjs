#!/usr/bin/env node
/**
 * Build the ADK Chat VSIX from the extension folder.
 * Run from project root: cd adk-chat-deploy && npm run build:vsix
 */
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployDir = path.resolve(__dirname, '..');
const root = path.resolve(deployDir, '..');
const extensionDir = path.join(root, 'extension');
const outDir = path.join(deployDir, 'dist');

if (!fs.existsSync(extensionDir)) {
  console.error('Extension folder not found:', extensionDir);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

console.log('Building extension...');
const prepublish = spawnSync('npm', ['run', 'vscode:prepublish'], {
  cwd: extensionDir,
  stdio: 'inherit',
});
if (prepublish.status !== 0) {
  process.exit(prepublish.status);
}

console.log('Packaging VSIX...');
const vsce = spawnSync('npx', ['vsce', 'package', '--no-dependencies', '--out', path.join(outDir, 'adk-chat.vsix')], {
  cwd: extensionDir,
  stdio: 'inherit',
});
if (vsce.status !== 0) {
  process.exit(vsce.status);
}

console.log('Done. VSIX: dist/adk-chat.vsix');
