import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const templatePath = path.join(PLUGIN_ROOT, 'ui', 'index.html');
const entryPath = path.join(PLUGIN_ROOT, 'ui', 'app.ts');
const outDir = path.join(PLUGIN_ROOT, 'ui', 'dist');
const outHtmlPath = path.join(outDir, 'app.html');

const result = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
});

const jsCode = result.outputFiles[0].text;
const template = await fs.readFile(templatePath, 'utf8');
const marker = '<!-- INLINE_SCRIPT -->';
const markerIndex = template.indexOf(marker);
if (markerIndex < 0) {
  throw new Error(`Missing ${marker} in ${templatePath}`);
}

const escapedJs = jsCode.replace(/<\/script>/gi, '<\\/script>');
// Verify inline JS parses cleanly before writing HTML.
new Function(escapedJs);

const finalHtml =
  template.slice(0, markerIndex) +
  `<script>${escapedJs}</script>` +
  template.slice(markerIndex + marker.length);

// Verify the exact script block embedded in finalHtml also parses cleanly.
const openTag = '<script>';
const closeTag = '</script>';
const start = finalHtml.indexOf(openTag);
const end = finalHtml.lastIndexOf(closeTag);
if (start < 0 || end <= start) {
  throw new Error('Failed to locate embedded <script> block in built HTML');
}
new Function(finalHtml.slice(start + openTag.length, end));

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(outHtmlPath, finalHtml, 'utf8');
console.log(`Built ${outHtmlPath} (${Buffer.byteLength(finalHtml, 'utf8')} bytes, syntax verified)`);
