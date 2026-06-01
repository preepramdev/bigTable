# BigTable CSV & TSV Viewer 🚀

An ultra-high-performance, lightweight, and feature-rich VS Code extension designed to open, search, and filter massive CSV/TSV files (millions of rows / gigabytes) instantly without crashing or freezing your editor.

Perfect for data analysts, backend developers, and system administrators who want to quickly inspect large log files, database exports, or transaction sheets side-by-side with their code—all without the memory bloat of Python/Pandas or the complexity of setting up database engines.

---

## Performance Metrics ⚡

Tested on a **3.50 GB CSV file (10,000,000 rows, 120 columns)**:
* 📂 **BOM & Encoding Auto-Detection:** Instant (< 5ms)
* ⚙️ **File Indexing & Metadata Prep:** **~6.2 seconds** (~560 MB/s scanning throughput)
* 🚀 **Page Loading (Anywhere in file):** **0.17 ms** (instantaneous seek)
* 🔍 **Global Full-File Substring Scan:** **~6.3 seconds** (~550 MB/s)
* 💾 **Active Memory Usage:** **< 80 MB** (uses a custom lazy-loading byte-stream engine)

---

## Core Features ✨

* ⚡ **Ultra-Fast Lazy Loading:** Indexes only the byte coordinates of lines. It loads data on-demand as you scroll, allowing you to open multi-gigabyte files in seconds using almost zero memory.
* 🔄 **Seamless Infinite Scroll:** Scrolling near the bottom of the visible table automatically loads and appends the next page of rows dynamically.
* ⚙️ **Advanced Condition Filtering:** Includes a structured multi-column condition filtering panel (AND) supporting operators like:
  * *Text matches:* `contains`, `starts with`, `ends with`, `equals`, `not equals`
  * *Numeric comparisons:* `>`, `<`, `≥ (greater or equal)`, `≤ (less or equal)`
* 🔍 **Global Highlighting Search:** Stream-search your entire dataset in seconds and instantly highlight all matches in bright yellow cells.
* 🌈 **Optional Rainbow Columns:** Toggles a beautiful, high-contrast, vertical color-coded layout using soft, readable pastel colors and colored borders to let your eyes trace wide columns with ease.
* 🔠 **Excel-Style Column Labels:** Quickly toggle vertical-stacked Excel-style header letters (`A`, `B`, `C` ... `AA`, `AB` ...) right above your header names.
* 🖱️ **Header Context Menu (Right-Click):** Right-click any column header to sort ascending/descending, clear sort, or hide the column instantly.
* 🙈 **One-Click Column Hiding:** Hover over a header and click the `×` to hide a column. A responsive "Show All" badge in the toolbar lets you restore them instantly.
* 🔤 **Smart Encoding Support:**
  * Auto-detects UTF-8 BOM, UTF-16LE, and UTF-16BE BOMs automatically.
  * Auto-detects Thai `Windows-874 / TIS-620` files without BOM by analyzing byte density, completely eliminating corrupted question marks (`?` / ``) on initial open.
  * Manual encoding selector dropdown supporting: `UTF-8`, `Windows-874 (Thai)`, `Windows-1252 (Western)`, `UTF-16LE`, `Shift-JIS (Japanese)`, and `GB18030 (Chinese)`.

---

## Interface Layout 🖥️

```text
┌────────────────────────────────────────────────────────────────────────┐
│ [BigTable CSV] File.csv     [Filter Rules ⚙️]    [Encoding: UTF-8 🗲]    │
├────────────────────────────────────────────────────────────────────────┤
│   #   │   A (Sorted ▲)        │   B                   │   C            │
│       │   Customer ID         │   First Name          │   Last Name    │
├───────┼───────────────────────┼───────────────────────┼────────────────┤
│   1   │   4962fdbE6Bfee6D     │   Pam                 │   Sparks       │
│   2   │   9b12Ae76fdBc9bE     │   Gina                │   Rocha        │
│   3   │   39edFd2F60C85BC     │   Kristie             │   Greer        │
└───────┴───────────────────────┴───────────────────────┴────────────────┘
```

---

## How It Works (Under the Hood) 🧠

1. **Native VS Code Custom Editor API:** Implements `vscode.CustomReadonlyEditorProvider` to bypass VS Code's internal text buffer memory limitations, allowing massive files to open safely without memory warnings or lag.
2. **Byte-Accurate Stream Scanner:** Scans raw buffers directly at the byte level looking for newline characters (`0x0A`) and quotes (`0x22`) in a single pass. This ensures 100% boundary-perfect indexing for all multi-byte encodings (like UTF-8 and UTF-16) with zero offset drift.
3. **No Database Overhead:** Unlike DuckDB or SQLite, it has no native C++ pre-compiled binding dependency or database runtime setup. It is pure TypeScript and compiles instantly, working with standard Node.js native streams.

---

## Installation 📦

### Via VS Code Marketplace (Recommended)
1. Open **Extensions** in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **BigTable CSV Viewer**.
3. Click **Install**.

### Direct VSIX Installation
1. Package the extension locally (see development steps).
2. Open VS Code, launch the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
3. Select **Extensions: Install from VSIX...** and select the `.vsix` file.

---

## Contributing & Local Development 🛠️

Want to customize or build the extension yourself?

1. Clone the repository and install devDependencies:
   ```bash
   npm install
   ```
2. Compile and compile types:
   ```bash
   npm run compile
   ```
3. Open the repository folder in VS Code and press **`F5`** to launch the **Extension Development Host** debug window.
4. Drag and drop any massive `.csv` or `.tsv` file into the debug window.
5. Right-click the file and select **Open with BigTable CSV Viewer** to test!
6. Package the extension into a shareable `.vsix` file locally:
   ```bash
   npx @vscode/vsce package --no-git-tag-version
   ```

---

## License 📄

This project is open-source and licensed under the [MIT License](LICENSE).
