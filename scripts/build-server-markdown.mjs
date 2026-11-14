import { buildServerCore, writeServerEntry } from './build-server-core.mjs';

export async function buildServerMarkdown(outdir) {
  const inputs = await buildServerCore(outdir);
  if (!inputs.some((file) => file.includes('src/server/markdown/')) ||
    !inputs.some((file) => file.includes('marked'))) {
    throw new Error('the server markdown bundle is missing its markdown source or lexer');
  }
  const names = await writeServerEntry('markdown', outdir);
  return { inputs: inputs.length, names: names.length };
}
