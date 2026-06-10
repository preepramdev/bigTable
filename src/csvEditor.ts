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

export class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CsvEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      }
    });
  }

  private static readonly viewType = 'bigTable.csvViewer';
  private readonly activePanels = new Map<CsvDocument, vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  // Required for vscode.CustomEditorProvider
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CsvDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

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
    this.activePanels.set(document, webviewPanel);
    webviewPanel.onDidDispose(() => {
      this.activePanels.delete(document);
    });

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
          case 'triggerSave':
            vscode.commands.executeCommand('workbench.action.files.save');
            break;

          case 'triggerUndo':
            vscode.commands.executeCommand('undo');
            break;

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

          case 'edit':
            // Apply the edit and notify VS Code about the change
            const editResult = await document.engine.editCell(message.rowId, message.colIndex, message.value);
            
            // Fire the custom document change event to notify VS Code
            this._onDidChangeCustomDocument.fire({
              document: document,
              undo: async () => {
                const undoneEdit = document.engine.undo();
                if (undoneEdit) {
                  let changedColIndex = -1;
                  for (let i = 0; i < undoneEdit.oldValues.length; i++) {
                    if (undoneEdit.oldValues[i] !== undoneEdit.newValues[i]) {
                      changedColIndex = i;
                      break;
                    }
                  }
                  if (changedColIndex !== -1) {
                    webviewPanel.webview.postMessage({
                      type: 'undone',
                      rowId: undoneEdit.rowId,
                      colIndex: changedColIndex,
                      value: undoneEdit.oldValues[changedColIndex]
                    });
                  }
                }
              },
              redo: async () => {
                document.engine.redo();
              }
            });

            // Notify webview about the edit
            webviewPanel.webview.postMessage({
              type: 'editApplied',
              rowId: message.rowId,
              colIndex: message.colIndex,
              value: message.value
            });
            break;

          case 'filter':
            if (!message.conditions || message.conditions.length === 0) {
              const defaultPage = await document.engine.readPage(0, message.pageSize || 100);
              webviewPanel.webview.postMessage({
                type: 'pageData',
                pageIndex: 0,
                rows: defaultPage
              });
            } else {
              const filterResults = await document.engine.filter(message.conditions, message.maxResults || 1000);
              webviewPanel.webview.postMessage({
                type: 'searchResults',
                query: '',
                rows: filterResults.rows
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

    /* Advanced Filter Panel Styles */
    .filter-panel {
      background-color: var(--header-bg);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .filter-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--header-fg);
    }

    .filter-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
    }

    .filter-select, .filter-input {
      background-color: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 5px;
      border-radius: 4px;
      font-size: 13px;
      outline: none;
    }

    .filter-select {
      max-width: 180px;
    }

    .filter-input {
      flex: 1;
      max-width: 250px;
    }

    .filter-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }

    .btn-delete-rule {
      background-color: transparent;
      color: var(--input-fg);
      border: none;
      cursor: pointer;
      font-size: 16px;
      opacity: 0.6;
      padding: 0 6px;
    }

    .btn-delete-rule:hover {
      color: var(--vscode-inputValidation-errorBorder, #be1111);
      opacity: 1;
    }

    /* Custom Context Menu Styles */
    .context-menu {
      position: absolute;
      background-color: var(--header-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      padding: 4px 0;
      min-width: 160px;
    }

    .context-menu-item {
      padding: 6px 12px;
      font-size: 13px;
      cursor: pointer;
      color: var(--fg);
      user-select: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .context-menu-item:hover {
      background-color: var(--hover-bg);
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
      <button class="btn btn-secondary" id="btn-toggle-filter" onclick="toggleFilterPanel()" title="Advanced Condition Filter (Multi-column)" style="margin-left: 4px;">
        <span>⚙️ Filter</span>
      </button>
      <span id="status-text" class="status-text">Loading file...</span>
    </div>

    <div class="toolbar-right">
      <label class="rainbow-toggle" title="Show Excel-style column letters (A, B, C...)">
        <input type="checkbox" id="excel-headers-checkbox" onchange="toggleExcelHeaders()" />
        <span>A, B, C... Labels</span>
      </label>
      <label class="rainbow-toggle">
        <input type="checkbox" id="rainbow-checkbox" onchange="toggleRainbow()" />
        <span>Rainbow Columns</span>
      </label>
      <label class="rainbow-toggle" title="Toggle cell editing mode">
        <input type="checkbox" id="edit-mode-checkbox" onchange="toggleEditMode()" />
        <span>✏️ Edit Mode</span>
      </label>
      <div id="edit-buttons-container" style="display: none; gap: 6px; align-items: center;">
        <button class="btn" id="btn-save" onclick="triggerSave()" title="Save Changes (Ctrl+S / Cmd+S)" style="padding: 4px 8px; font-size: 11px;" disabled>💾 Save</button>
        <button class="btn btn-secondary" id="btn-undo" onclick="triggerUndo()" title="Undo (Ctrl+Z / Cmd+Z)" style="padding: 4px 8px; font-size: 11px;" disabled>↩️ Undo</button>
      </div>
      <select id="encoding-select" class="page-size-select" onchange="changeEncoding()" title="Change File Encoding">
        <option value="utf-8" selected>UTF-8</option>
        <option value="windows-874">Windows-874 (Thai)</option>
        <option value="windows-1252">Windows-1252 (Western)</option>
        <option value="utf-16le">UTF-16LE</option>
        <option value="shift-jis">Shift-JIS (Japanese)</option>
        <option value="gb18030">GB18030 (Chinese)</option>
      </select>
      <div id="sort-badge" class="columns-badge hidden" style="background-color: rgba(14, 99, 156, 0.15); border-color: var(--accent);">
        <span id="sort-text">Sorted by: --</span>
        <button class="btn btn-secondary" onclick="clearSortFromBadge()" title="Clear Sorting" style="padding: 1px 5px; line-height: 1; font-size: 11px; margin-left: 4px; background: transparent; border: none; cursor: pointer;">&times;</button>
      </div>
      <div id="columns-badge" class="columns-badge hidden">
        <span id="columns-count">Columns: --</span>
        <button id="btn-reset-cols" class="btn btn-secondary hidden" onclick="resetColumns()">Show All</button>
      </div>
    </div>
  </div>

  <div id="filter-panel" class="filter-panel hidden">
    <div class="filter-header">
      <span style="font-weight: 600; font-size: 13px; color: var(--header-fg);">Advanced Condition Filters (AND)</span>
      <button class="btn btn-secondary" onclick="addFilterRow()" style="padding: 3px 8px; font-size: 11px;">+ Add Rule</button>
    </div>
    <div id="filter-rows-container">
      <!-- Filter rows will be dynamically appended here -->
    </div>
    <div class="filter-footer">
      <button class="btn" onclick="applyAdvancedFilter()">Apply Filter</button>
      <button class="btn btn-secondary" onclick="clearAdvancedFilter()">Clear All</button>
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

  <div id="context-menu" class="context-menu hidden">
    <div class="context-menu-item" onclick="handleContextMenuAction('sort-asc')">
      <span>▲</span> Sort Ascending
    </div>
    <div class="context-menu-item" onclick="handleContextMenuAction('sort-desc')">
      <span>▼</span> Sort Descending
    </div>
    <div class="context-menu-item" onclick="handleContextMenuAction('sort-clear')">
      <span>✕</span> Clear Sort
    </div>
    <div class="context-menu-item" onclick="handleContextMenuAction('hide')">
      <span>👁‍🗨</span> Hide Column
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
    let showExcelHeaders = false;

    // Edit mode State
    let editModeEnabled = false;

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
    const filterPanel = document.getElementById('filter-panel');
    const filterRowsContainer = document.getElementById('filter-rows-container');
    const btnToggleFilter = document.getElementById('btn-toggle-filter');
    const contextMenu = document.getElementById('context-menu');
    let contextMenuColIndex = null;
    const sortBadge = document.getElementById('sort-badge');
    const sortText = document.getElementById('sort-text');

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
        
        case 'editApplied':
          // Update the loadedRows array with the new value
          if (message.rowId >= 0 && message.colIndex >= 0) {
            // Find the row in loadedRows and update it
            const rowIndex = loadedRows.findIndex(row => {
              // Assuming rows now have id property
              return row.id === message.rowId;
            });
            
            if (rowIndex !== -1) {
              loadedRows[rowIndex].values[message.colIndex] = message.value;
              // Re-render just the affected cell for better performance
              updateCellInTable(message.rowId, message.colIndex, message.value);
            }
          }
          break;

        case 'saved':
          editedCells.clear();
          updateEditButtons();
          clearAllDirtyIndicators();
          break;

        case 'reverted':
          editedCells.clear();
          updateEditButtons();
          clearAllDirtyIndicators();
          vscode.postMessage({ type: 'ready', pageSize: pageSize });
          break;

        case 'undone': {
          const cellKey = message.rowId + '_' + message.colIndex;
          editedCells.delete(cellKey);
          
          const rIdx = loadedRows.findIndex(row => row.id === message.rowId);
          if (rIdx !== -1) {
            loadedRows[rIdx].values[message.colIndex] = message.value;
          }
          
          revertCellInTable(message.rowId, message.colIndex, message.value);
          updateEditButtons();
          break;
        }
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
        
        const excelLabel = showExcelHeaders 
          ? \`<div style="font-size: 10px; opacity: 0.5; font-weight: bold; margin-bottom: 2px; text-transform: uppercase;">\${getExcelColumnLabel(c)}</div>\` 
          : '';

        html += \`
          <th class="rainbow-hdr-\${c % 10}" onclick="toggleSort(\${c}, event)" oncontextmenu="handleHeaderContextMenu(\${c}, event)">
            <div class="th-content">
              <div style="display: flex; flex-direction: column;">
                \${excelLabel}
                <span class="th-label" title="\${escapeHtml(headers[c])}">
                  \${escapeHtml(headers[c])}\${sortIndicator}
                </span>
              </div>
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

          let val = row.values && row.values[c] !== undefined ? row.values[c] : '';
          let escVal = escapeHtml(val);
          
          if (regex && escVal) {
            escVal = escVal.replace(regex, '<mark>$1</mark>');
          }
          
          rowHtml += \`<td class="rainbow-cell-\${c % 10}" title="\${escapeHtml(val)}">\${escVal}</td>\`;
        }
        html += \`<tr data-row-id="\${row.id}">\${rowHtml}</tr>\`;
      }

      if (loadedRows.length === 0) {
        html = \`<tr><td colspan="\${headers.length + 1}" style="text-align: center; padding: 32px; color: var(--header-fg); opacity: 0.8;">No records loaded</td></tr>\`;
      }

      tableBody.innerHTML = html;
      initializeEditMode();
    }

    function updateCellInTable(rowId, colIndex, value) {
      const tableBody = document.getElementById('table-body');
      const row = tableBody.querySelector(\`tr[data-row-id="\${rowId}"]\`);
      
      if (row) {
        // Find the cell in this row (skip row index column)
        const cells = row.querySelectorAll('td:not(.row-index)');
        let currentCol = 0;
        
        for (let j = 0; j < cells.length; j++) {
          if (!hiddenCols.has(currentCol)) {
            if (currentCol === colIndex) {
              cells[j].textContent = value;
              cells[j].style.backgroundColor = 'rgba(14, 99, 156, 0.2)';
              cells[j].style.borderLeft = '2px solid var(--accent)';
              break;
            }
          }
          currentCol++;
        }
      }
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
        updateSortBadge();
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
        const valA = (a.values && a.values[colIdx]) || '';
        const valB = (b.values && b.values[colIdx]) || '';
        
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

    function toggleExcelHeaders() {
      showExcelHeaders = document.getElementById('excel-headers-checkbox').checked;
      renderHeaders();
    }

    function toggleEditMode() {
      editModeEnabled = document.getElementById('edit-mode-checkbox').checked;
      
      // Update visual feedback
      const tableBody = document.getElementById('table-body');
      if (tableBody) {
        if (editModeEnabled) {
          // Show that cells are editable
          const cells = tableBody.querySelectorAll('td:not(.row-index)');
          cells.forEach(cell => {
            cell.style.cursor = 'text';
            cell.title = 'Double-click or press Enter to edit';
          });
        } else {
          // Show that cells are read-only
          const cells = tableBody.querySelectorAll('td:not(.row-index)');
          cells.forEach(cell => {
            cell.style.cursor = 'default';
            cell.title = '';
          });
        }
      }
      
      // Show/hide Save and Undo buttons
      const editButtonsContainer = document.getElementById('edit-buttons-container');
      if (editButtonsContainer) {
        editButtonsContainer.style.display = editModeEnabled ? 'inline-flex' : 'none';
        updateEditButtons();
      }
      
      // If there's an active edit, cancel it when turning off edit mode
      if (!editModeEnabled && currentlyEditing) {
        finishCellEdit(true); // Cancel the edit
      }
    }

    function getExcelColumnLabel(index) {
      let label = '';
      let temp = index;
      while (temp >= 0) {
        label = String.fromCharCode((temp % 26) + 65) + label;
        temp = Math.floor(temp / 26) - 1;
      }
      return label;
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

    function toggleFilterPanel() {
      filterPanel.classList.toggle('hidden');
      if (!filterPanel.classList.contains('hidden') && filterRowsContainer.children.length === 0) {
        addFilterRow();
      }
    }

    function addFilterRow() {
      if (!headers || headers.length === 0) return;

      const rowDiv = document.createElement('div');
      rowDiv.className = 'filter-row';

      const colSelect = document.createElement('select');
      colSelect.className = 'filter-select';
      for (let c = 0; c < headers.length; c++) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = headers[c];
        colSelect.appendChild(opt);
      }

      const opSelect = document.createElement('select');
      opSelect.className = 'filter-select';
      const ops = [
        { val: 'contains', label: 'contains' },
        { val: 'starts_with', label: 'starts with' },
        { val: 'ends_with', label: 'ends with' },
        { val: 'equals', label: 'equals (=)' },
        { val: 'not_equals', label: 'not equals (≠)' },
        { val: 'greater_than', label: 'greater than (>)' },
        { val: 'less_than', label: 'less than (<)' },
        { val: 'greater_than_or_equal', label: 'greater or equal (≥)' },
        { val: 'less_than_or_equal', label: 'less or equal (≤)' }
      ];
      for (const op of ops) {
        const opt = document.createElement('option');
        opt.value = op.val;
        opt.textContent = op.label;
        opSelect.appendChild(opt);
      }

      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'filter-input';
      valInput.placeholder = 'Value...';
      valInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          applyAdvancedFilter();
        }
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete-rule';
      delBtn.innerHTML = '&times;';
      delBtn.title = 'Remove this rule';
      delBtn.onclick = () => {
        rowDiv.remove();
        if (filterRowsContainer.children.length === 0) {
          clearAdvancedFilter();
        }
      };

      rowDiv.appendChild(colSelect);
      rowDiv.appendChild(opSelect);
      rowDiv.appendChild(valInput);
      rowDiv.appendChild(delBtn);

      filterRowsContainer.appendChild(rowDiv);
    }

    function applyAdvancedFilter() {
      const rows = filterRowsContainer.getElementsByClassName('filter-row');
      const conditions = [];

      for (const r of rows) {
        const selects = r.getElementsByClassName('filter-select');
        const input = r.getElementsByClassName('filter-input')[0];
        const val = input.value.trim();

        if (val === '') continue;

        conditions.push({
          colIndex: parseInt(selects[0].value, 10),
          operator: selects[1].value,
          value: val
        });
      }

      if (conditions.length === 0) {
        clearAdvancedFilter();
        return;
      }

      isSearching = true;
      allRowsLoaded = true;
      showLoading('Applying advanced filters...');
      vscode.postMessage({
        type: 'filter',
        conditions: conditions,
        maxResults: 1000
      });
    }

    function clearAdvancedFilter() {
      filterRowsContainer.innerHTML = '';
      filterPanel.classList.add('hidden');
      isSearching = false;
      allRowsLoaded = false;
      pageIndex = 0;
      showLoading('Restoring original table...');
      vscode.postMessage({ type: 'ready', pageSize: pageSize });
    }

    function handleHeaderContextMenu(colIndex, event) {
      event.preventDefault();
      contextMenuColIndex = colIndex;
      contextMenu.style.left = \`\${event.clientX}px\`;
      contextMenu.style.top = \`\${event.clientY}px\`;
      contextMenu.classList.remove('hidden');
    }

    function handleContextMenuAction(action) {
      if (contextMenuColIndex === null) return;
      
      switch (action) {
        case 'sort-asc':
          sortColIndex = contextMenuColIndex;
          sortDirection = 'asc';
          applySort();
          break;
        case 'sort-desc':
          sortColIndex = contextMenuColIndex;
          sortDirection = 'desc';
          applySort();
          break;
        case 'sort-clear':
          sortColIndex = null;
          sortDirection = null;
          restoreOriginalOrder();
          break;
        case 'hide':
          hiddenCols.add(contextMenuColIndex);
          renderHeaders();
          renderRows(currentQuery);
          updateColumnsCounter();
          break;
      }
      contextMenu.classList.add('hidden');
    }

    function applySort() {
      showLoading('Sorting column...');
      updateSortBadge();
      setTimeout(() => {
        sortData(sortColIndex, sortDirection);
        renderHeaders();
        renderRows(currentQuery);
        hideLoading();
      }, 50);
    }

    function restoreOriginalOrder() {
      showLoading('Restoring original table order...');
      updateSortBadge();
      setTimeout(() => {
        vscode.postMessage({ type: 'ready', pageSize: loadedRows.length });
      }, 50);
    }

    function updateSortBadge() {
      if (sortColIndex !== null && headers[sortColIndex]) {
        sortText.textContent = \`Sorted: \${headers[sortColIndex]} (\${sortDirection === 'asc' ? '▲' : '▼'})\`;
        sortBadge.classList.remove('hidden');
      } else {
        sortBadge.classList.add('hidden');
      }
    }

    function clearSortFromBadge() {
      sortColIndex = null;
      sortDirection = null;
      restoreOriginalOrder();
    }

    window.addEventListener('click', () => {
      contextMenu.classList.add('hidden');
    });

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

    // Cell editing functions
    let editedCells = new Map(); // Map of rowId_colIndex -> {originalValue, editedValue}
    let currentlyEditing = null; // {rowIndex, colIndex, tdElement, originalValue}

    function startCellEdit(rowId, colIndex, tdElement) {
      if (!editModeEnabled) return;
      
      if (currentlyEditing) {
        finishCellEdit(true); // Cancel previous edit
      }

      const originalValue = tdElement.textContent;
      
      // Create input element
      const input = document.createElement('input');
      input.type = 'text';
      input.value = originalValue;
      input.className = 'cell-edit-input';
      input.style.width = '100%';
      input.style.height = '100%';
      input.style.boxSizing = 'border-box';
      input.style.backgroundColor = 'var(--input-bg)';
      input.style.color = 'var(--input-fg)';
      input.style.border = '2px solid var(--accent)';
      input.style.outline = 'none';
      input.style.fontFamily = 'inherit';
      input.style.fontSize = 'inherit';
      input.style.padding = '2px 4px';
      
      // Save editing state
      currentlyEditing = {
        rowId,
        colIndex,
        tdElement,
        originalValue,
        input
      };
      
      // Clear cell content and add input
      tdElement.innerHTML = '';
      tdElement.appendChild(input);
      input.focus();
      input.select();
      
      // Handle key events
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          finishCellEdit(false); // Save edit
        } else if (e.key === 'Escape') {
          finishCellEdit(true); // Cancel edit
        }
      });
      
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (currentlyEditing && currentlyEditing.input === input) {
            finishCellEdit(false); // Save on blur
          }
        }, 100);
      });
    }

    function finishCellEdit(cancel) {
      if (!currentlyEditing) return;
      
      const { rowId, colIndex, tdElement, originalValue, input } = currentlyEditing;
      const newValue = cancel ? originalValue : input.value.trim();
      
      // Restore cell content
      tdElement.innerHTML = '';
      tdElement.textContent = newValue;
      
      // Mark cell as edited if value changed
      if (!cancel && newValue !== originalValue) {
        const cellKey = rowId + '_' + colIndex;
        editedCells.set(cellKey, {
          originalValue,
          editedValue: newValue
        });
        tdElement.style.backgroundColor = 'rgba(14, 99, 156, 0.2)'; // Light blue background for edited cells
        tdElement.style.borderLeft = '2px solid var(--accent)';
        
        updateEditButtons();

        // Send edit to extension
        vscode.postMessage({
          type: 'edit',
          rowId: rowId,
          colIndex: colIndex,
          value: newValue
        });
      } else if (cancel) {
        // If canceled, remove any existing edit marker
        const cellKey = rowId + '_' + colIndex;
        editedCells.delete(cellKey);
        tdElement.style.backgroundColor = '';
        tdElement.style.borderLeft = '';
        updateEditButtons();
      }
      
      currentlyEditing = null;
    }

    function updateEditButtons() {
      const btnSave = document.getElementById('btn-save');
      const btnUndo = document.getElementById('btn-undo');
      const hasEdits = editedCells.size > 0;
      
      if (btnSave) {
        btnSave.disabled = !hasEdits;
      }
      if (btnUndo) {
        btnUndo.disabled = !hasEdits;
      }
    }

    function clearAllDirtyIndicators() {
      const tableBody = document.getElementById('table-body');
      if (tableBody) {
        const cells = tableBody.querySelectorAll('td:not(.row-index)');
        cells.forEach(cell => {
          cell.style.backgroundColor = '';
          cell.style.borderLeft = '';
        });
      }
    }

    function revertCellInTable(rowId, colIndex, value) {
      const tableBody = document.getElementById('table-body');
      const row = tableBody.querySelector('tr[data-row-id="' + rowId + '"]');
      if (row) {
        const cells = row.querySelectorAll('td:not(.row-index)');
        let currentCol = 0;
        
        for (let j = 0; j < cells.length; j++) {
          if (!hiddenCols.has(currentCol)) {
            if (currentCol === colIndex) {
              cells[j].textContent = value;
              cells[j].style.backgroundColor = '';
              cells[j].style.borderLeft = '';
              break;
            }
          }
          currentCol++;
        }
      }
    }

    function triggerSave() {
      vscode.postMessage({ type: 'triggerSave' });
    }

    function triggerUndo() {
      vscode.postMessage({ type: 'triggerUndo' });
    }

    // Make table cells editable
    function makeCellsEditable() {
      const tableBody = document.getElementById('table-body');
      if (!tableBody) return;
      
      // Store the event handlers so we can remove them later if needed
      if (!window.bigTableEventHandlers) {
        window.bigTableEventHandlers = {
          dblclick: null,
          keydown: null
        };
      }
      
      // Remove existing handlers if they exist
      if (window.bigTableEventHandlers.dblclick) {
        tableBody.removeEventListener('dblclick', window.bigTableEventHandlers.dblclick);
      }
      if (window.bigTableEventHandlers.keydown) {
        tableBody.removeEventListener('keydown', window.bigTableEventHandlers.keydown);
      }
      
      // Define new handlers
      const dblclickHandler = (e) => {
        if (!editModeEnabled) return;
        
        const td = e.target.closest('td');
        if (!td || td.classList.contains('row-index')) return;
        
        // Find row index and column index
        const tr = td.closest('tr');
        const rowId = parseInt(tr.dataset.rowId, 10);
        const cells = Array.from(tr.children);
        const colIndex = cells.indexOf(td) - 1; // Subtract 1 for row index column
        
        if (!isNaN(rowId) && colIndex >= 0) {
          startCellEdit(rowId, colIndex, td);
        }
      };
      
      const keydownHandler = (e) => {
        if (!editModeEnabled) return;
        
        if (e.key === 'Enter' && e.target.tagName !== 'INPUT') {
          const activeElement = document.activeElement;
          if (activeElement.tagName === 'TD' && !activeElement.classList.contains('row-index')) {
            const td = activeElement;
            const tr = td.closest('tr');
            const rowId = parseInt(tr.dataset.rowId, 10);
            const cells = Array.from(tr.children);
            const colIndex = cells.indexOf(td) - 1;
            
            if (!isNaN(rowId) && colIndex >= 0) {
              e.preventDefault();
              startCellEdit(rowId, colIndex, td);
            }
          }
        }
      };
      
      // Add event listeners
      tableBody.addEventListener('dblclick', dblclickHandler);
      tableBody.addEventListener('keydown', keydownHandler);
      
      // Store handlers for later removal
      window.bigTableEventHandlers.dblclick = dblclickHandler;
      window.bigTableEventHandlers.keydown = keydownHandler;
      
      // Add tabindex to make cells focusable
      const cells = tableBody.querySelectorAll('td:not(.row-index)');
      cells.forEach(cell => {
        cell.tabIndex = 0;
      });
    }

    // Call this after rows are rendered
    function initializeEditMode() {
      // Initially, edit mode is disabled by default
      // Users need to explicitly enable it via the toggle
      editModeEnabled = false;
      const editModeCheckbox = document.getElementById('edit-mode-checkbox');
      if (editModeCheckbox) {
        editModeCheckbox.checked = false;
      }
      
      // Set up the event handlers, but they will check editModeEnabled
      makeCellsEditable();
    }

    function disableCellEditing() {
      // Simple function that just updates visual state
      const tableBody = document.getElementById('table-body');
      if (tableBody) {
        const cells = tableBody.querySelectorAll('td:not(.row-index)');
        cells.forEach(cell => {
          cell.style.cursor = 'default';
          cell.title = '';
        });
      }
    }
  </script>
</body>
</html>`;
  }

  // Required methods for vscode.CustomEditorProvider
  public async saveCustomDocument(
    document: CsvDocument,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.engine.saveEdits();
    const panel = this.activePanels.get(document);
    if (panel) {
      panel.webview.postMessage({ type: 'saved' });
    }
  }

  public async saveCustomDocumentAs(
    document: CsvDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.engine.saveEditsAs(destination.fsPath);
  }

  public async revertCustomDocument(
    document: CsvDocument,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    document.engine.clearEdits();
    const panel = this.activePanels.get(document);
    if (panel) {
      panel.webview.postMessage({ type: 'reverted' });
    }
  }

  public async backupCustomDocument(
    document: CsvDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    // Create a backup file with pending edits
    const backupPath = await document.engine.createBackup(context.destination.fsPath);
    return {
      id: backupPath,
      delete: () => {
        // Delete the backup file
      }
    };
  }
}
