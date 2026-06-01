import * as vscode from 'vscode';
import * as path from 'path';
import { CsvEngine } from './csvEngine';

class CsvDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  public readonly engine: CsvEngine;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
    this.engine = new CsvEngine(uri.fsPath);
  }

  dispose(): void {
    // No-op
  }
}

export class CsvEditorProvider implements vscode.CustomReadonlyEditorProvider<CsvDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CsvEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      }
    });
  }

  private static readonly viewType = 'bigTable.csvViewer';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<CsvDocument> {
    return new CsvDocument(uri);
  }

  public async resolveCustomEditor(
    document: CsvDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document.uri);

    // Track the indexing progress
    document.engine.setProgressCallback((count, complete) => {
      webviewPanel.webview.postMessage({
        type: 'progress',
        totalRows: count,
        isComplete: complete,
        headers: document.engine.getHeaders()
      });
    });

    // Start background indexing
    document.engine.startIndexing().catch(err => {
      webviewPanel.webview.postMessage({
        type: 'error',
        message: `Indexing failed: ${err.message}`
      });
    });

    // Listen to messages from Webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'ready':
            await document.engine.startIndexing();
            const firstPage = await document.engine.readPage(0, message.pageSize || 100);
            webviewPanel.webview.postMessage({
              type: 'init',
              headers: document.engine.getHeaders(),
              totalRows: document.engine.getTotalRows(),
              isComplete: document.engine.isComplete(),
              firstPage: firstPage,
              encoding: document.engine.getEncoding()
            });
            break;

          case 'changeEncoding':
            document.engine.setEncoding(message.encoding);
            await document.engine.startIndexing();
            const reloadedPage = await document.engine.readPage(0, message.pageSize || 100);
            webviewPanel.webview.postMessage({
              type: 'init',
              headers: document.engine.getHeaders(),
              totalRows: document.engine.getTotalRows(),
              isComplete: document.engine.isComplete(),
              firstPage: reloadedPage,
              encoding: document.engine.getEncoding()
            });
            break;

          case 'getPage':
            const pageData = await document.engine.readPage(message.pageIndex, message.pageSize);
            webviewPanel.webview.postMessage({
              type: 'pageData',
              pageIndex: message.pageIndex,
              rows: pageData
            });
            break;

          case 'search':
            if (!message.query) {
              const defaultPage = await document.engine.readPage(0, message.pageSize || 100);
              webviewPanel.webview.postMessage({
                type: 'pageData',
                pageIndex: 0,
                rows: defaultPage
              });
            } else {
              const searchResults = await document.engine.search(message.query, message.maxResults || 1000);
              webviewPanel.webview.postMessage({
                type: 'searchResults',
                query: message.query,
                rows: searchResults.rows
              });
            }
            break;
        }
      } catch (err: any) {
        webviewPanel.webview.postMessage({
          type: 'error',
          message: err.message
        });
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview, uri: vscode.Uri): string {
    const filename = path.basename(uri.fsPath);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BigTable CSV Viewer - ${filename}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --border: var(--vscode-panel-border, #444444);
      --header-bg: var(--vscode-sideBar-background, #252526);
      --header-fg: var(--vscode-sideBar-foreground, #cccccc);
      --hover-bg: var(--vscode-list-hoverBackground, #2a2d2e);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      --font-mono: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font-family);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      box-sizing: border-box;
    }

    /* Toolbar Styles */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background-color: var(--header-bg);
      border-bottom: 1px solid var(--border);
      gap: 16px;
      flex-wrap: wrap;
    }

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .toolbar-title {
      font-weight: bold;
      font-size: 14px;
      color: var(--header-fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }

    .search-box {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-box input {
      background-color: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 6px 28px 6px 10px;
      border-radius: 4px;
      font-size: 13px;
      outline: none;
      width: 240px;
    }

    .search-box input:focus {
      border-color: var(--accent);
    }

    .search-clear {
      position: absolute;
      right: 8px;
      cursor: pointer;
      display: none;
      font-size: 14px;
      color: var(--input-fg);
      opacity: 0.7;
    }

    .search-clear:hover {
      opacity: 1;
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .columns-badge {
      font-size: 11px;
      background-color: rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
      color: var(--header-fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn {
      background-color: var(--accent);
      color: var(--accent-fg);
      border: none;
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      user-select: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .btn:hover {
      opacity: 0.9;
    }

    .btn-secondary {
      background-color: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background-color: rgba(255, 255, 255, 0.05);
    }

    .status-text {
      font-size: 12px;
      color: var(--header-fg);
      opacity: 0.8;
    }

    /* Table Container Styles */
    .table-container {
      flex: 1;
      overflow: auto;
      position: relative;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      font-size: 13px;
      font-family: var(--font-mono);
      text-align: left;
    }

    th {
      position: sticky;
      top: 0;
      background-color: var(--header-bg);
      color: var(--header-fg);
      padding: 8px 12px;
      border-bottom: 2px solid var(--border);
      border-right: 1px solid var(--border);
      white-space: nowrap;
      z-index: 10;
      font-family: var(--font-family);
      font-weight: 600;
      user-select: none;
      cursor: pointer;
    }

    th:hover {
      background-color: var(--hover-bg);
    }

    .th-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .th-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .th-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .sort-indicator {
      font-size: 10px;
      opacity: 0.8;
      color: var(--accent);
    }

    .hide-col-btn {
      cursor: pointer;
      font-size: 12px;
      opacity: 0.4;
      padding: 0 4px;
      border-radius: 2px;
    }

    .hide-col-btn:hover {
      opacity: 1;
      background-color: rgba(255, 255, 255, 0.1);
    }

    td {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      border-right: 1px solid var(--border);
      white-space: nowrap;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    tr:nth-child(even) {
      background-color: rgba(255, 255, 255, 0.02);
    }

    tr:hover {
      background-color: var(--hover-bg);
    }

    .row-index {
      color: var(--header-fg);
      opacity: 0.6;
      text-align: right;
      width: 60px;
      font-family: var(--font-family);
      background-color: var(--header-bg);
      position: sticky;
      left: 0;
      z-index: 5;
      border-right: 2px solid var(--border);
    }

    th.row-index-hdr {
      left: 0;
      z-index: 15;
      width: 60px;
      border-right: 2px solid var(--border);
      cursor: default;
    }

    th.row-index-hdr:hover {
      background-color: var(--header-bg);
    }

    mark {
      background-color: #ffeb3b;
      color: #000000;
      border-radius: 2px;
      padding: 0 2px;
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      font-size: 16px;
      font-weight: bold;
    }

    .load-more-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-size: 13px;
      color: var(--header-fg);
      background-color: rgba(255, 255, 255, 0.01);
      border-top: 1px solid var(--border);
      gap: 12px;
    }

    .spinner {
      border: 3px solid rgba(255, 255, 255, 0.1);
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border-left-color: var(--accent);
      animation: spin 1s linear infinite;
    }

    .spinner.small {
      width: 14px;
      height: 14px;
      border-width: 2px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .hidden {
      display: none !important;
    }

    .banner {
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .banner.error {
      background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #be1111);
    }

    /* Rainbow Columns Styles */
    #csv-table.rainbow-enabled th.rainbow-hdr-0 { border-bottom: 2px solid #e57373; color: #e57373 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-1 { border-bottom: 2px solid #f48fb1; color: #f48fb1 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-2 { border-bottom: 2px solid #ba68c8; color: #ba68c8 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-3 { border-bottom: 2px solid #9575cd; color: #9575cd !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-4 { border-bottom: 2px solid #64b5f6; color: #64b5f6 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-5 { border-bottom: 2px solid #4dd0e1; color: #4dd0e1 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-6 { border-bottom: 2px solid #81c784; color: #81c784 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-7 { border-bottom: 2px solid #dce775; color: #dce775 !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-8 { border-bottom: 2px solid #ffd54f; color: #ffd54f !important; }
    #csv-table.rainbow-enabled th.rainbow-hdr-9 { border-bottom: 2px solid #ffb74d; color: #ffb74d !important; }

    #csv-table.rainbow-enabled td.rainbow-cell-0 { background-color: rgba(229, 115, 115, 0.1); border-right: 1px solid rgba(229, 115, 115, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-1 { background-color: rgba(244, 143, 177, 0.1); border-right: 1px solid rgba(244, 143, 177, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-2 { background-color: rgba(186, 104, 200, 0.1); border-right: 1px solid rgba(186, 104, 200, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-3 { background-color: rgba(149, 117, 205, 0.1); border-right: 1px solid rgba(149, 117, 205, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-4 { background-color: rgba(100, 181, 246, 0.1); border-right: 1px solid rgba(100, 181, 246, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-5 { background-color: rgba(77,  208, 225, 0.1); border-right: 1px solid rgba(77,  208, 225, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-6 { background-color: rgba(129, 199, 132, 0.1); border-right: 1px solid rgba(129, 199, 132, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-7 { background-color: rgba(220, 231, 117, 0.1); border-right: 1px solid rgba(220, 231, 117, 0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-8 { background-color: rgba(255, 213, 79,  0.1); border-right: 1px solid rgba(255, 213, 79,  0.2); }
    #csv-table.rainbow-enabled td.rainbow-cell-9 { background-color: rgba(255, 183, 77,  0.1); border-right: 1px solid rgba(255, 183, 77,  0.2); }

    .rainbow-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--header-fg);
      cursor: pointer;
      user-select: none;
      background-color: rgba(255, 255, 255, 0.04);
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    .rainbow-toggle:hover {
      background-color: rgba(255, 255, 255, 0.08);
    }

    .rainbow-toggle input {
      cursor: pointer;
      margin: 0;
    }
  </style>
</head>
<body>
  <div id="error-banner" class="banner error hidden">
    <span id="error-message"></span>
    <button class="btn" onclick="hideError()">Dismiss</button>
  </div>

  <div class="toolbar">
    <div class="toolbar-left">
      <div class="toolbar-title" title="${filename}">${filename}</div>
      <div class="search-box">
        <input type="text" id="search-input" placeholder="Search / Filter rows (Press Enter)..." autocomplete="off" />
        <span id="search-clear" class="search-clear" onclick="clearSearch()">&times;</span>
      </div>
      <span id="status-text" class="status-text">Loading file...</span>
    </div>

    <div class="toolbar-right">
      <label class="rainbow-toggle">
        <input type="checkbox" id="rainbow-checkbox" onchange="toggleRainbow()" />
        <span>Rainbow Columns</span>
      </label>
      <select id="encoding-select" class="page-size-select" onchange="changeEncoding()" title="Change File Encoding">
        <option value="utf-8" selected>UTF-8</option>
        <option value="windows-874">Windows-874 (Thai)</option>
        <option value="windows-1252">Windows-1252 (Western)</option>
        <option value="utf-16le">UTF-16LE</option>
        <option value="shift-jis">Shift-JIS (Japanese)</option>
        <option value="gb18030">GB18030 (Chinese)</option>
      </select>
      <div id="columns-badge" class="columns-badge hidden">
        <span id="columns-count">Columns: --</span>
        <button id="btn-reset-cols" class="btn btn-secondary hidden" onclick="resetColumns()">Show All</button>
      </div>
    </div>
  </div>

  <div class="table-container" id="table-container">
    <div id="loading" class="loading-overlay">
      <div class="spinner"></div>
      <span id="loading-text" style="margin-left: 12px;">Parsing CSV metadata...</span>
    </div>
    
    <table id="csv-table">
      <thead id="table-head"></thead>
      <tbody id="table-body"></tbody>
    </table>

    <div id="load-more-container" class="load-more-indicator hidden">
      <div class="spinner small"></div>
      <span>Loading more rows (scrolling down)...</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // App State
    let headers = [];
    let loadedRows = [];
    let totalRows = 0;
    let pageIndex = 0;
    const pageSize = 250; // Read in comfortable 250 rows pages
    let isComplete = false;
    let currentQuery = '';
    let isSearching = false;
    let isLoadingMore = false;
    let allRowsLoaded = false;

    // Sorting State
    let sortColIndex = null;
    let sortDirection = null; // 'asc' | 'desc' | null

    // Column visibility State
    let hiddenCols = new Set();

    // DOM Elements
    const tableContainer = document.getElementById('table-container');
    const tableHead = document.getElementById('table-head');
    const tableBody = document.getElementById('table-body');
    const statusText = document.getElementById('status-text');
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');
    const columnsBadge = document.getElementById('columns-badge');
    const columnsCount = document.getElementById('columns-count');
    const btnResetCols = document.getElementById('btn-reset-cols');
    const loadingOverlay = document.getElementById('loading');
    const loadingText = document.getElementById('loading-text');
    const loadMoreContainer = document.getElementById('load-more-container');
    const errorBanner = document.getElementById('error-banner');
    const errorMessage = document.getElementById('error-message');

    // Trigger Initial State Request
    vscode.postMessage({ type: 'ready', pageSize: pageSize });

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'init':
          headers = message.headers;
          totalRows = message.totalRows;
          isComplete = message.isComplete;
          loadedRows = message.firstPage;
          
          if (message.encoding) {
            document.getElementById('encoding-select').value = message.encoding;
          }
          
          hideLoading();
          renderHeaders();
          renderRows();
          updateStatus();
          break;

        case 'progress':
          totalRows = message.totalRows;
          isComplete = message.isComplete;
          if (message.headers && headers.length === 0) {
            headers = message.headers;
            renderHeaders();
          }
          updateStatus();
          break;

        case 'pageData':
          const newRows = message.rows;
          pageIndex = message.pageIndex;
          isLoadingMore = false;
          loadMoreContainer.classList.add('hidden');
          
          if (newRows.length === 0) {
            allRowsLoaded = true;
          } else {
            loadedRows = loadedRows.concat(newRows);
            if (sortColIndex !== null) {
              // Apply existing sort to the entire dataset
              sortData(sortColIndex, sortDirection);
            }
            renderRows();
          }
          updateStatus();
          break;

        case 'searchResults':
          loadedRows = message.rows;
          isSearching = false;
          allRowsLoaded = true; // In search mode, we show all search results (up to limit) without infinite scroll
          hideLoading();
          renderRows(message.query);
          statusText.textContent = \`Found \${loadedRows.length}\${loadedRows.length >= 1000 ? '+' : ''} matching rows\`;
          break;

        case 'error':
          showError(message.message);
          hideLoading();
          loadMoreContainer.classList.add('hidden');
          break;
      }
    });

    // Infinite Scrolling Event Listener
    tableContainer.addEventListener('scroll', () => {
      if (currentQuery || isLoadingMore || allRowsLoaded || loadedRows.length >= totalRows) return;
      
      const { scrollTop, clientHeight, scrollHeight } = tableContainer;
      // When scrolled within 250px of the bottom, load more
      if (scrollTop + clientHeight >= scrollHeight - 250) {
        loadMore();
      }
    });

    function loadMore() {
      isLoadingMore = true;
      loadMoreContainer.classList.remove('hidden');
      vscode.postMessage({
        type: 'getPage',
        pageIndex: pageIndex + 1,
        pageSize: pageSize
      });
    }

    // Search Key Events
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        triggerSearch();
      }
    });

    searchInput.addEventListener('input', () => {
      if (searchInput.value) {
        searchClear.style.display = 'block';
      } else {
        searchClear.style.display = 'none';
        clearSearch();
      }
    });

    function triggerSearch() {
      const query = searchInput.value.trim();
      currentQuery = query;
      if (query === '') {
        clearSearch();
        return;
      }
      isSearching = true;
      showLoading(\`Searching for "\${query}" across file...\`);
      vscode.postMessage({ type: 'search', query: query, maxResults: 1000 });
    }

    function clearSearch() {
      searchInput.value = '';
      currentQuery = '';
      searchClear.style.display = 'none';
      allRowsLoaded = false;
      pageIndex = 0;
      sortColIndex = null;
      sortDirection = null;
      showLoading('Loading rows...');
      vscode.postMessage({ type: 'ready', pageSize: pageSize });
    }

    // Header Rendering
    function renderHeaders() {
      if (!headers || headers.length === 0) return;
      
      columnsBadge.classList.remove('hidden');
      updateColumnsCounter();

      let html = '<th class="row-index-hdr">#</th>';
      for (let c = 0; c < headers.length; c++) {
        if (hiddenCols.has(c)) continue;
        
        const isSorted = sortColIndex === c;
        const sortIndicator = isSorted ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
        
        html += \`
          <th class="rainbow-hdr-\${c % 10}" onclick="toggleSort(\${c}, event)">
            <div class="th-content">
              <span class="th-label" title="\${escapeHtml(headers[c])}">
                \${escapeHtml(headers[c])}\${sortIndicator}
              </span>
              <span class="th-actions">
                <span class="hide-col-btn" title="Hide column" onclick="hideColumn(\${c}, event)">&times;</span>
              </span>
            </div>
          </th>
        \`;
      }
      tableHead.innerHTML = \`<tr>\${html}</tr>\`;
    }

    // Rows Rendering
    function renderRows(highlightQuery = '') {
      let html = '';
      const escQuery = highlightQuery ? escapeRegExp(highlightQuery) : null;
      const regex = escQuery ? new RegExp(\`(\${escQuery})\`, 'gi') : null;

      for (let r = 0; r < loadedRows.length; r++) {
        const row = loadedRows[r];
        const displayIndex = r + 1;
        let rowHtml = \`<td class="row-index">\${displayIndex}</td>\`;
        
        for (let c = 0; c < headers.length; c++) {
          if (hiddenCols.has(c)) continue;

          let val = row[c] !== undefined ? row[c] : '';
          let escVal = escapeHtml(val);
          
          if (regex && escVal) {
            escVal = escVal.replace(regex, '<mark>$1</mark>');
          }
          
          rowHtml += \`<td class="rainbow-cell-\${c % 10}" title="\${escapeHtml(val)}">\${escVal}</td>\`;
        }
        html += \`<tr>\${rowHtml}</tr>\`;
      }

      if (loadedRows.length === 0) {
        html = \`<tr><td colspan="\${headers.length + 1}" style="text-align: center; padding: 32px; color: var(--header-fg); opacity: 0.8;">No records loaded</td></tr>\`;
      }

      tableBody.innerHTML = html;
    }

    // Sorting Logic (Client side for instant feeling)
    function toggleSort(colIndex, event) {
      // Prevent sorting if clicked on the Hide (x) button
      if (event.target.classList.contains('hide-col-btn')) return;

      if (sortColIndex === colIndex) {
        if (sortDirection === 'asc') sortDirection = 'desc';
        else if (sortDirection === 'desc') {
          sortColIndex = null;
          sortDirection = null;
        }
      } else {
        sortColIndex = colIndex;
        sortDirection = 'asc';
      }

      showLoading('Sorting column...');
      setTimeout(() => {
        if (sortColIndex !== null) {
          sortData(sortColIndex, sortDirection);
        } else {
          // Re-load the original page list to restore order
          vscode.postMessage({ type: 'ready', pageSize: loadedRows.length });
          return;
        }
        renderHeaders();
        renderRows(currentQuery);
        hideLoading();
      }, 50);
    }

    function sortData(colIdx, dir) {
      loadedRows.sort((a, b) => {
        const valA = a[colIdx] || '';
        const valB = b[colIdx] || '';
        
        const numA = Number(valA);
        const numB = Number(valB);
        
        if (valA !== '' && !isNaN(numA) && valB !== '' && !isNaN(numB)) {
          return dir === 'asc' ? numA - numB : numB - numA;
        }
        
        return dir === 'asc'
          ? valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' })
          : valB.localeCompare(valA, undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    // Column Hiding Actions
    function hideColumn(colIndex, event) {
      event.stopPropagation();
      hiddenCols.add(colIndex);
      renderHeaders();
      renderRows(currentQuery);
      updateColumnsCounter();
    }

    function resetColumns() {
      hiddenCols.clear();
      renderHeaders();
      renderRows(currentQuery);
      updateColumnsCounter();
    }

    function toggleRainbow() {
      const isEnabled = document.getElementById('rainbow-checkbox').checked;
      const table = document.getElementById('csv-table');
      if (isEnabled) {
        table.classList.add('rainbow-enabled');
      } else {
        table.classList.remove('rainbow-enabled');
      }
    }

    function changeEncoding() {
      const encoding = document.getElementById('encoding-select').value;
      showLoading('Re-indexing file with new encoding...');
      vscode.postMessage({
        type: 'changeEncoding',
        encoding: encoding,
        pageSize: pageSize
      });
    }

    function updateColumnsCounter() {
      const visibleCount = headers.length - hiddenCols.size;
      columnsCount.textContent = \`Cols: \${visibleCount} of \${headers.length}\`;
      if (hiddenCols.size > 0) {
        btnResetCols.classList.remove('hidden');
      } else {
        btnResetCols.classList.add('hidden');
      }
    }

    function updateStatus() {
      if (currentQuery) return;
      const progressLabel = isComplete ? '' : ' (indexing...)';
      statusText.textContent = \`Showing \${formatNumber(loadedRows.length)} of \${formatNumber(totalRows)} rows\${progressLabel}\`;
    }

    function showLoading(text) {
      loadingText.textContent = text || 'Loading...';
      loadingOverlay.classList.remove('hidden');
    }

    function hideLoading() {
      loadingOverlay.classList.add('hidden');
    }

    function showError(msg) {
      errorMessage.textContent = msg;
      errorBanner.classList.remove('hidden');
    }

    function hideError() {
      errorBanner.classList.add('hidden');
    }

    function escapeHtml(str) {
      if (typeof str !== 'string') return String(str);
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function escapeRegExp(string) {
      return string.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    }

    function formatNumber(num) {
      return num.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
    }
  </script>
</body>
</html>`;
  }
}
