/// <reference types="vite/client" />
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import { expect, test } from 'vitest';

import bashUrl from '../../tree-sitter-bash.wasm?url';

test('parses in a browser, loading the Wasm files over HTTP', async () => {
  await Parser.init({ locateFile: () => runtimeUrl });
  const parser = new Parser();
  parser.setLanguage(await Language.load(bashUrl));
  expect(parser.parse('echo hi\n')?.rootNode.toString()).toBe(
    '(program (command name: (command_name (word)) argument: (word)))'
  );
});
