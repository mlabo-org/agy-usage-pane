import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const entryPath = path.join(PLUGIN_ROOT, 'server', 'index.mjs');
const outDir = path.join(PLUGIN_ROOT, 'dist');
const outFile = path.join(outDir, 'server.mjs');

await fs.mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile: outFile,
  minify: false,
  sourcemap: false,
  banner: {
    js: "import { createRequire as __agyUsageCreateRequire } from 'node:module'; const require = __agyUsageCreateRequire(import.meta.url);",
  },
});

const stat = await fs.stat(outFile);
console.log(`Built ${outFile} (${stat.size} bytes)`);
