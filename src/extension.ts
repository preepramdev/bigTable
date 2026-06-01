import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditor';

export function activate(context: vscode.ExtensionContext) {
  // Register the custom editor provider
  context.subscriptions.push(CsvEditorProvider.register(context));

  // Register the command to manually open a CSV file in BigTable Viewer
  const openCommand = vscode.commands.registerCommand('bigTable.openCsv', (uri: vscode.Uri) => {
    if (uri) {
      vscode.commands.executeCommand('vscode.openWith', uri, 'bigTable.csvViewer');
    } else {
      vscode.window.showErrorMessage('No file selected.');
    }
  });
  context.subscriptions.push(openCommand);
}

export function deactivate() {}
