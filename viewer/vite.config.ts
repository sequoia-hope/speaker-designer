import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function resolveProjectPort(): number {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (args[i].startsWith('--port=')) {
      const parsed = Number.parseInt(args[i].slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  if (process.env.PORT) {
    const parsed = Number.parseInt(process.env.PORT, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  try {
    const out = execFileSync('proj', ['port'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    }).trim();
    const parsed = Number.parseInt(out, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch (err) {
    throw new Error(
      `Failed to resolve project port via --port, $PORT, or \`proj port\`: ${String(err)}`
    );
  }

  throw new Error('Could not resolve project port (--port, $PORT, or `proj port` required).');
}

export default defineConfig(({ command }) => {
  const serverConfig =
    command === 'serve'
      ? {
          port: resolveProjectPort(),
          strictPort: true,
          host: '0.0.0.0',
        }
      : undefined;

  return {
    plugins: [svelte()],
    base: './',
    server: serverConfig,
    build: {
      outDir: path.resolve(import.meta.dirname, '..'),
      assetsDir: 'viewer-assets',
      emptyOutDir: false,
      sourcemap: false,
    },
  };
});
