import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function resolveServerUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const out = execFileSync('proj', ['url', 'speaker-designer'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  }).trim();
  if (!out.startsWith('http')) {
    throw new Error(`Unexpected output from \`proj url speaker-designer\`: ${out}`);
  }
  return out;
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 30_000,
  use: {
    baseURL: resolveServerUrl(),
    viewport: { width: 1620, height: 980 },
    launchOptions: {
      args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'],
    },
  },
});
