import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Keep esbuild in Node: jsdom's TextEncoder/Uint8Array realms are incompatible.
// Interaction and native session ACL tests live in dashboard.test.tsx.
describe('conversation and global library browser boundary', () => {
  it('bundles both native clients without importing host storage, execution, or model routing', async () => {
    const result = await build({
      entryPoints: ['src/client.tsx'], bundle: true, write: false, metafile: true,
      platform: 'browser', format: 'cjs', external: ['react', 'react/jsx-runtime'], jsx: 'automatic',
    });
    const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(entry => entry.external && ['react', 'react/jsx-runtime'].includes(entry.path))).toBe(true);
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs).toContain('src/model.ts');
    expect(inputs).toContain('src/settings-integration.tsx');
    expect(inputs).toContain('src/remote-client.ts');
    expect(inputs).toContain('src/library-remote-client.ts');
    expect(inputs).toContain('src/library-model.ts');
    for (const path of ['src/index.ts', 'src/projection.ts', 'src/remote.ts', 'src/library-remote.ts',
      'src/agent-library.ts', 'src/engine.ts', 'src/runtime.ts', 'src/model-route.ts', 'src/model-catalog.ts']) {
      expect(inputs).not.toContain(path);
    }
    expect(result.outputFiles[0]!.text).toContain('module.exports');
  });
});
