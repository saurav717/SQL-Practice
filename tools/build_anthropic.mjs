// Rebuild the vendored Anthropic SDK bundle.
//
// The site ships no bundler: assets/js/*.js are loaded by the browser as
// plain modules. The SDK is npm-shaped and multi-file, so it gets the same
// treatment DuckDB-Wasm gets -- bundled once, checked in, loaded from
// engine/. Run this only when bumping the SDK version, then commit the
// result and update engine/anthropic/NOTICE.md with the new version.
//
//   npm install          # @anthropic-ai/sdk is a devDependency
//   npm run build:sdk
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'engine/anthropic/anthropic-browser.bundle.mjs');
const pkg = path.join(ROOT, 'node_modules/@anthropic-ai/sdk/package.json');

if (!fs.existsSync(pkg)) {
  console.error('error: @anthropic-ai/sdk is not installed.\n'
    + '       run: npm install');
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;

// Re-exported by name rather than `export * from`: the browser only ever
// needs the client, and naming it keeps the bundle's public surface a thing
// assistant.js can be read against.
const entry = path.join(ROOT, 'node_modules/.anthropic-entry.mjs');
fs.writeFileSync(entry, "export { default as Anthropic } from '@anthropic-ai/sdk';\n");

await build({
  entryPoints: [entry],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  banner: { js: `// @anthropic-ai/sdk ${version} -- bundled for the browser by tools/build_anthropic.mjs.\n// Do not edit. See NOTICE.md.` },
});
fs.unlinkSync(entry);

const bytes = fs.statSync(OUT).size;
console.log(`built @anthropic-ai/sdk ${version} -> ${path.relative(ROOT, OUT)} (${(bytes / 1024).toFixed(0)} KB)`);
console.log('remember to update engine/anthropic/NOTICE.md if the version changed');
