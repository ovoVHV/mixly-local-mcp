globalThis.__MIXLY_HARNESS_GENERATION__ = 4;

const source = await (async () => {
  const fs = globalThis.require('node:fs');
  const path = globalThis.require('node:path');
  const adapterPath = path.join(process.env.LOCALAPPDATA, 'MixlyHarness', 'adapter', 'mixly_harness_adapter.js');
  return fs.readFileSync(adapterPath, 'utf8');
})();

(0, eval)(source);

const blocks = {};
const generators = {};
export { blocks, generators };
