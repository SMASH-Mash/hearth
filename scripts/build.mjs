// Bundles the official MCP Apps host bridge for the browser → web/vendor/app-bridge.js
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../web/vendor/app-bridge.js', import.meta.url));
await build({
  stdin: {
    contents: "export { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: out,
  logLevel: 'warning',
});
console.log('built web/vendor/app-bridge.js');
