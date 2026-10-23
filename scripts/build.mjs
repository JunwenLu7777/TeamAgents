import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('lib', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true,
    platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true,
  }),
  build({
    entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', bundle: true,
    platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'], sourcemap: true,
    banner: { js: 'window.__ModuleLoader__.load({id:"dsh-team-agents",factory(require){const module={exports:{}};const exports=module.exports;' },
    footer: { js: 'return module.exports;}});' },
  }),
]);
console.log('Built host ESM and DSH lazy-factory browser bundle. No server was started.');
