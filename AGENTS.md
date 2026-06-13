# BigTable CSV Viewer

## Build & verify

```bash
npm run compile        # tsc -p ./ (only quality gate — no linter/formatter)
npx @vscode/vsce package --no-git-tag-version   # build .vsix
```

TypeScript `strict: true` is the only code quality tool. No ESLint, no Prettier, no test framework.

## Dev loop

Open this folder in VS Code and press **F5** to launch a new Extension Development Host. The `preLaunchTask` compiles first (`npm: compile`).

## Architecture

Only 4 source files in `src/`:

| File | Role |
|---|---|
| `extension.ts` | Entrypoint — registers `CsvEditorProvider` and the `bigTable.openCsv` command |
| `csvEditor.ts` | Webview UI provider (~2300 lines of inline HTML/CSS/JS in a template string). Communication via `postMessage`. |
| `csvEngine.ts` | Lazy-loading byte-stream CSV engine — indexes newline byte-offsets, pages on demand, auto-detects encoding/BOM/delimiter |
| `testEngine.ts` | Standalone benchmark — generates a 3.5 GB file, indexes, reads, searches. Not a unit test. |

**Zero runtime dependencies** — pure TypeScript + Node built-ins.

## Testing

No test framework. The only test-like script is a benchmark:

```bash
node out/testEngine.js
```

This creates/cleans up a ~3.5 GB CSV file in `out/`. It is excluded from the VSIX package.

## Key quirks

- **Activation:** `"activationEvents": []` — activates on demand when a `.csv` file is opened with this editor.
- **Custom editor selector:** `"filenamePattern": "*.csv"` only. TSV files must be opened via command palette.
- **Redo is a stub:** `CsvEngine.redo()` always returns `null`.
- **`.vsix` files are committed** to the repo (three versions).
- **Webview context retained** (`retainContextWhenHidden: true`) — state persists across tab switches.
- **Package metadata** — publisher is `preepramdev`, extension name is `big-table-csv-viewer`.
