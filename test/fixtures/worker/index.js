// A Cloudflare Worker that parses its request body. Workers cannot compile Wasm from bytes at run time, so both the
// runtime and the grammar are imported as precompiled modules.
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';

import bash from '../../../tree-sitter-bash.wasm';

let language;

export default {
  async fetch(request) {
    language ??= Parser.init({ wasmModule: runtime }).then(() => Language.load(bash));
    const bashLanguage = await language;
    const parser = new Parser();
    parser.setLanguage(bashLanguage);
    const tree = parser.parse(await request.text());
    return new Response(tree.rootNode.toString());
  },
};
