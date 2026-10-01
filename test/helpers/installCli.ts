import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Several tests run script/tree-sitter, whose first run downloads the CLI or, when no released binary runs here, builds
// it for over 10 minutes on GitHub's Intel macOS runner. Installing it once before the tests keeps that cost out of
// their timeouts and keeps concurrent tests from building it side by side.
export default function installCli(): void {
  execFileSync('script/tree-sitter', ['--version'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    stdio: 'inherit',
  });
}
