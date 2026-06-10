import * as fs from 'fs';

export interface FilterCondition {
  colIndex: number;
  operator: 'contains' | 'starts_with' | 'ends_with' | 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'greater_than_or_equal' | 'less_than_or_equal';
  value: string;
}

export function parseCsvLine(line: string, delimiter = ','): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  
  if (line.endsWith('\r')) {
    line = line.slice(0, -1);
  }

  const quoteChars = ['"', '“', '”', '\uFFFD'];

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (quoteChars.includes(char)) {
      if (inQuotes) {
        if (char === quoteChar || (quoteChar === '“' && char === '”') || (quoteChar === '\uFFFD' && char === '\uFFFD')) {
          if (line[i + 1] === char) {
            current += char;
            i++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
            quoteChar = '';
          }
        } else {
          current += char;
        }
      } else {
        inQuotes = true;
        quoteChar = char;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  
  return result.map(val => val.replace(/\uFFFD/g, ''));
}

export function matchConditions(row: string[], conditions: FilterCondition[]): boolean {
  for (const cond of conditions) {
    const cellVal = row[cond.colIndex] || '';
    const condVal = cond.value;
    
    switch (cond.operator) {
      case 'contains':
        if (!cellVal.toLowerCase().includes(condVal.toLowerCase())) return false;
        break;
      case 'starts_with':
        if (!cellVal.toLowerCase().startsWith(condVal.toLowerCase())) return false;
        break;
      case 'ends_with':
        if (!cellVal.toLowerCase().endsWith(condVal.toLowerCase())) return false;
        break;
      case 'equals':
        if (cellVal.toLowerCase() !== condVal.toLowerCase()) return false;
        break;
      case 'not_equals':
        if (cellVal.toLowerCase() === condVal.toLowerCase()) return false;
        break;
      case 'greater_than': {
        const numCell = Number(cellVal);
        const numCond = Number(condVal);
        if (isNaN(numCell) || isNaN(numCond) || numCell <= numCond) return false;
        break;
      }
      case 'less_than': {
        const numCell = Number(cellVal);
        const numCond = Number(condVal);
        if (isNaN(numCell) || isNaN(numCond) || numCell >= numCond) return false;
        break;
      }
      case 'greater_than_or_equal': {
        const numCell = Number(cellVal);
        const numCond = Number(condVal);
        if (isNaN(numCell) || isNaN(numCond) || numCell < numCond) return false;
        break;
      }
      case 'less_than_or_equal': {
        const numCell = Number(cellVal);
        const numCond = Number(condVal);
        if (isNaN(numCell) || isNaN(numCond) || numCell > numCond) return false;
        break;
      }
    }
  }
  return true;
}

export interface EditedRow {
  id: number;
  values: string[];
}

export class CsvEngine {
  private filePath: string;
  private lineOffsets: number[] = [];
  private headers: string[] = [];
  private indexingPromise: Promise<void> | null = null;
  private isIndexingComplete = false;
  private onProgressCallback?: (rowsCount: number, isComplete: boolean) => void;
  private delimiter = ',';
  private encoding = 'utf-8';
  private hasHeaders = true;
  
  // Edit tracking
  private pendingEdits = new Map<number, string[]>();
  private editHistory: Array<{rowId: number, oldValues: string[], newValues: string[]}> = [];

  constructor(filePath: string, onProgress?: (rowsCount: number, isComplete: boolean) => void) {
    this.filePath = filePath;
    this.onProgressCallback = onProgress;
  }

  public getHeaders(): string[] {
    return this.headers;
  }

  public getTotalRows(): number {
    if (this.hasHeaders) {
      return Math.max(0, this.lineOffsets.length - 1);
    } else {
      return this.lineOffsets.length;
    }
  }

  public isComplete(): boolean {
    return this.isIndexingComplete;
  }

  public setProgressCallback(callback: (rowsCount: number, isComplete: boolean) => void) {
    this.onProgressCallback = callback;
    if (this.lineOffsets.length > 0 || this.isIndexingComplete) {
      callback(this.getTotalRows(), this.isIndexingComplete);
    }
  }

  public getEncoding(): string {
    return this.encoding;
  }

  public setEncoding(encoding: string): void {
    if (this.encoding !== encoding) {
      this.encoding = encoding;
      this.lineOffsets = [];
      this.headers = [];
      this.indexingPromise = null;
      this.isIndexingComplete = false;
    }
  }

  public async startIndexing(): Promise<void> {
    if (this.indexingPromise) {
      return this.indexingPromise;
    }
    this.indexingPromise = this.indexFile();
    return this.indexingPromise;
  }

  private async autoDetectEncoding(fd: fs.promises.FileHandle, totalSize: number): Promise<string> {
    const bomBuffer = Buffer.alloc(4);
    await fd.read(bomBuffer, 0, 4, 0);
    
    if (bomBuffer[0] === 0xff && bomBuffer[1] === 0xfe) {
      return 'utf-16le';
    }
    if (bomBuffer[0] === 0xfe && bomBuffer[1] === 0xff) {
      return 'utf-16be';
    }
    
    const sampleSize = Math.min(16384, totalSize);
    const sampleBuffer = Buffer.alloc(sampleSize);
    await fd.read(sampleBuffer, 0, sampleSize, 0);

    let isUtf8 = true;
    let thaiByteCount = 0;
    let i = 0;

    while (i < sampleSize) {
      const b = sampleBuffer[i];
      if (b >= 161 && b <= 251) {
        thaiByteCount++;
      }

      if (b < 128) {
        i++;
        continue;
      }
      
      if ((b & 0xE0) === 0xC0) {
        if (i + 1 >= sampleSize || (sampleBuffer[i + 1] & 0xC0) !== 0x80) {
          isUtf8 = false;
          break;
        }
        i += 2;
      } else if ((b & 0xF0) === 0xE0) {
        if (i + 2 >= sampleSize || (sampleBuffer[i + 1] & 0xC0) !== 0x80 || (sampleBuffer[i + 2] & 0xC0) !== 0x80) {
          isUtf8 = false;
          break;
        }
        i += 3;
      } else if ((b & 0xF8) === 0xF0) {
        if (i + 3 >= sampleSize || (sampleBuffer[i + 1] & 0xC0) !== 0x80 || (sampleBuffer[i + 2] & 0xC0) !== 0x80 || (sampleBuffer[i + 3] & 0xC0) !== 0x80) {
          isUtf8 = false;
          break;
        }
        i += 4;
      } else {
        isUtf8 = false;
        break;
      }
    }

    if (isUtf8) {
      return 'utf-8';
    }

    if (thaiByteCount > 10) {
      return 'windows-874';
    }

    return 'windows-1252';
  }

  private detectHeaderRow(firstRow: string[]): boolean {
    for (const val of firstRow) {
      const cleanVal = val.replace(/[“”"]/g, '').trim();
      if (cleanVal === '') continue;
      
      if (!isNaN(Number(cleanVal)) && cleanVal.length > 0) {
        return false;
      }
      if (cleanVal.includes('@') && cleanVal.includes('.')) {
        return false;
      }
      if (cleanVal.startsWith('http://') || cleanVal.startsWith('https://')) {
        return false;
      }
    }
    return true;
  }

  private async indexFile(): Promise<void> {
    const fd = await fs.promises.open(this.filePath, 'r');
    const stats = await fd.stat();
    const totalSize = stats.size;

    if (totalSize === 0) {
      this.headers = [];
      this.lineOffsets = [0];
      this.isIndexingComplete = true;
      this.onProgressCallback?.(0, true);
      await fd.close();
      return;
    }

    if (this.encoding === 'utf-8') {
      this.encoding = await this.autoDetectEncoding(fd, totalSize);
    }

    const initialBufferSize = Math.min(65536, totalSize);
    const initialBuffer = Buffer.alloc(initialBufferSize);
    await fd.read(initialBuffer, 0, initialBufferSize, 0);
    
    const decoder = new TextDecoder(this.encoding, { fatal: false });
    let initialText = decoder.decode(initialBuffer);
    
    if (initialText.startsWith('\uFEFF')) {
      initialText = initialText.slice(1);
    }

    const firstLineEnd = initialText.indexOf('\n');
    const firstLine = firstLineEnd === -1 ? initialText : initialText.slice(0, firstLineEnd);
    this.delimiter = this.detectDelimiter(firstLine);
    
    const parsedFirstLine = parseCsvLine(firstLine, this.delimiter);
    this.hasHeaders = this.detectHeaderRow(parsedFirstLine);

    if (this.hasHeaders) {
      this.headers = parsedFirstLine;
    } else {
      this.headers = Array.from({ length: parsedFirstLine.length }, (_, i) => `Col ${i + 1}`);
    }

    this.lineOffsets = [0];
    const bufferSize = 1024 * 1024;
    const buffer = Buffer.alloc(bufferSize);
    let offset = 0;
    let inQuotes = false;
    
    const isUtf16Le = this.encoding === 'utf-16le';
    const isUtf16Be = this.encoding === 'utf-16be';

    while (offset < totalSize) {
      const bytesToRead = Math.min(bufferSize, totalSize - offset);
      const { bytesRead } = await fd.read(buffer, 0, bytesToRead, offset);
      
      if (isUtf16Le) {
        for (let i = 0; i < bytesRead; i += 2) {
          const charCode = buffer[i] | (buffer[i + 1] << 8);
          if (charCode === 34) {
            inQuotes = !inQuotes;
          } else if (charCode === 10 && !inQuotes) {
            const nextLineOffset = offset + i + 2;
            if (nextLineOffset < totalSize) {
              this.lineOffsets.push(nextLineOffset);
            }
          }
        }
      } else if (isUtf16Be) {
        for (let i = 0; i < bytesRead; i += 2) {
          const charCode = (buffer[i] << 8) | buffer[i + 1];
          if (charCode === 34) {
            inQuotes = !inQuotes;
          } else if (charCode === 10 && !inQuotes) {
            const nextLineOffset = offset + i + 2;
            if (nextLineOffset < totalSize) {
              this.lineOffsets.push(nextLineOffset);
            }
          }
        }
      } else {
        for (let i = 0; i < bytesRead; i++) {
          const charCode = buffer[i];
          if (charCode === 34) {
            inQuotes = !inQuotes;
          } else if (charCode === 10 && !inQuotes) {
            const nextLineOffset = offset + i + 1;
            if (nextLineOffset < totalSize) {
              this.lineOffsets.push(nextLineOffset);
            }
          }
        }
      }

      offset += bytesRead;

      if (this.lineOffsets.length % 50000 === 0) {
        this.onProgressCallback?.(this.getTotalRows(), false);
      }
    }

    await fd.close();
    this.isIndexingComplete = true;
    this.onProgressCallback?.(this.getTotalRows(), true);
  }

  private detectDelimiter(line: string): string {
    const delimiters = [',', '\t', ';', '|'];
    let bestDelimiter = ',';
    let maxCount = -1;
    for (const d of delimiters) {
      const count = line.split(d).length - 1;
      if (count > maxCount) {
        maxCount = count;
        bestDelimiter = d;
      }
    }
    return bestDelimiter;
  }

  public async readPage(pageIndex: number, pageSize: number): Promise<EditedRow[]> {
    await this.startIndexing();

    const startRow = pageIndex * pageSize + (this.hasHeaders ? 1 : 0);
    if (startRow >= this.lineOffsets.length) {
      return [];
    }

    const endRow = Math.min(startRow + pageSize, this.lineOffsets.length);
    const startByte = this.lineOffsets[startRow];
    const endByte = endRow < this.lineOffsets.length ? this.lineOffsets[endRow] : null;

    const fd = await fs.promises.open(this.filePath, 'r');
    const stats = await fd.stat();
    const finalByte = endByte !== null ? endByte : stats.size;
    const lengthToRead = finalByte - startByte;

    if (lengthToRead <= 0) {
      await fd.close();
      return [];
    }

    const buffer = Buffer.alloc(lengthToRead);
    await fd.read(buffer, 0, lengthToRead, startByte);
    await fd.close();

    const decoder = new TextDecoder(this.encoding, { fatal: false });
    const text = decoder.decode(buffer);
    
    const rawLines = text.split(/\r?\n/);
    const lines = rawLines.filter((l, idx) => {
      if (idx === rawLines.length - 1 && l === '') {
        return false;
      }
      return true;
    });

    const parsedRows: EditedRow[] = [];
    let currentRowId = pageIndex * pageSize;
    
    for (const line of lines) {
      const rowId = currentRowId++;
      // Check if this row has pending edits
      if (this.pendingEdits.has(rowId)) {
        parsedRows.push({
          id: rowId,
          values: this.pendingEdits.get(rowId)!
        });
      } else {
        parsedRows.push({
          id: rowId,
          values: parseCsvLine(line, this.delimiter)
        });
      }
    }

    return parsedRows;
  }

  public async search(query: string, maxResults = 1000): Promise<{ rows: EditedRow[] }> {
    const fd = await fs.promises.open(this.filePath, 'r');
    const stats = await fd.stat();
    const totalSize = stats.size;

    const lowercaseQuery = query.toLowerCase();
    const results: EditedRow[] = [];
    
    let offset = 0;
    const bufferSize = 1024 * 1024;
    const buffer = Buffer.alloc(bufferSize);
    
    const decoder = new TextDecoder(this.encoding, { fatal: false });
    let remainingText = '';
    let isFirstLine = true;
    let rowIndex = this.hasHeaders ? -1 : 0;

    while (offset < totalSize && results.length < maxResults) {
      const bytesToRead = Math.min(bufferSize, totalSize - offset);
      const { bytesRead } = await fd.read(buffer, 0, bytesToRead, offset);
      offset += bytesRead;

      const chunkText = remainingText + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = chunkText.split(/\r?\n/);
      
      remainingText = lines.pop() || '';

      for (const line of lines) {
        if (isFirstLine) {
          isFirstLine = false;
          if (this.hasHeaders) {
            continue;
          }
        }

        const rowId = rowIndex++;
        // Get values (either edited or from file)
        const values = this.pendingEdits.has(rowId)
          ? this.pendingEdits.get(rowId)!
          : parseCsvLine(line, this.delimiter);

        // Search in the values (including edited ones)
        const searchText = values.join(this.delimiter).toLowerCase();
        if (searchText.includes(lowercaseQuery)) {
          results.push({ id: rowId, values });
          if (results.length >= maxResults) {
            break;
          }
        }
      }
    }

    remainingText += decoder.decode(new Uint8Array(), { stream: false });
    if (results.length < maxResults && remainingText) {
      const rowId = rowIndex++;
      const values = this.pendingEdits.has(rowId)
        ? this.pendingEdits.get(rowId)!
        : parseCsvLine(remainingText, this.delimiter);
      
      const searchText = values.join(this.delimiter).toLowerCase();
      if (searchText.includes(lowercaseQuery)) {
        results.push({ id: rowId, values });
      }
    }

    await fd.close();
    return { rows: results };
  }

  public async filter(conditions: FilterCondition[], maxResults = 1000): Promise<{ rows: EditedRow[] }> {
    const fd = await fs.promises.open(this.filePath, 'r');
    const stats = await fd.stat();
    const totalSize = stats.size;

    const results: EditedRow[] = [];
    
    let offset = 0;
    const bufferSize = 1024 * 1024;
    const buffer = Buffer.alloc(bufferSize);
    
    const decoder = new TextDecoder(this.encoding, { fatal: false });
    let remainingText = '';
    let isFirstLine = true;
    let rowIndex = this.hasHeaders ? -1 : 0;

    while (offset < totalSize && results.length < maxResults) {
      const bytesToRead = Math.min(bufferSize, totalSize - offset);
      const { bytesRead } = await fd.read(buffer, 0, bytesToRead, offset);
      offset += bytesRead;

      const chunkText = remainingText + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = chunkText.split(/\r?\n/);
      
      remainingText = lines.pop() || '';

      for (const line of lines) {
        if (isFirstLine) {
          isFirstLine = false;
          if (this.hasHeaders) {
            continue;
          }
        }

        const rowId = rowIndex++;
        // Get values (either edited or from file)
        const values = this.pendingEdits.has(rowId)
          ? this.pendingEdits.get(rowId)!
          : parseCsvLine(line, this.delimiter);

        if (matchConditions(values, conditions)) {
          results.push({ id: rowId, values });
          if (results.length >= maxResults) {
            break;
          }
        }
      }
    }

    remainingText += decoder.decode(new Uint8Array(), { stream: false });
    if (results.length < maxResults && remainingText) {
      const rowId = rowIndex++;
      const values = this.pendingEdits.has(rowId)
        ? this.pendingEdits.get(rowId)!
        : parseCsvLine(remainingText, this.delimiter);
      
      if (matchConditions(values, conditions)) {
        results.push({ id: rowId, values });
      }
    }

    await fd.close();
    return { rows: results };
  }

  // Edit methods
  public async editCell(rowId: number, colIndex: number, newValue: string): Promise<{ oldValues: string[], newValues: string[] }> {
    if (rowId < 0 || rowId >= this.getTotalRows()) {
      throw new Error(`Invalid row ID: ${rowId}`);
    }
    if (colIndex < 0 || colIndex >= this.headers.length) {
      throw new Error(`Invalid column index: ${colIndex}`);
    }

    // Get current values (either from pending edits or from file)
    const currentValues = this.pendingEdits.has(rowId) 
      ? [...this.pendingEdits.get(rowId)!]
      : await this.getRowValues(rowId);

    const oldValues = [...currentValues];
    currentValues[colIndex] = newValue;
    
    // Store the edit
    this.pendingEdits.set(rowId, currentValues);
    
    // Record history for undo/redo
    this.editHistory.push({ rowId, oldValues, newValues: currentValues });
    
    return { oldValues, newValues: currentValues };
  }

  private async getRowValues(rowId: number): Promise<string[]> {
    await this.startIndexing();
    
    const adjustedRowId = rowId + (this.hasHeaders ? 1 : 0);
    if (adjustedRowId >= this.lineOffsets.length) {
      throw new Error(`Row ID out of bounds: ${rowId}`);
    }

    const startByte = this.lineOffsets[adjustedRowId];
    const endByte = adjustedRowId + 1 < this.lineOffsets.length 
      ? this.lineOffsets[adjustedRowId + 1] 
      : null;

    const fd = await fs.promises.open(this.filePath, 'r');
    const stats = await fd.stat();
    const finalByte = endByte !== null ? endByte : stats.size;
    const lengthToRead = finalByte - startByte;

    const buffer = Buffer.alloc(lengthToRead);
    await fd.read(buffer, 0, lengthToRead, startByte);
    await fd.close();

    const decoder = new TextDecoder(this.encoding, { fatal: false });
    const text = decoder.decode(buffer);
    const line = text.split(/\r?\n/)[0];
    
    return parseCsvLine(line, this.delimiter);
  }

  public hasPendingEdits(): boolean {
    return this.pendingEdits.size > 0;
  }

  public clearEdits(): void {
    this.pendingEdits.clear();
    this.editHistory = [];
  }

  public async saveEdits(): Promise<void> {
    if (this.pendingEdits.size === 0) {
      return;
    }

    // Create a temporary file and write all lines with edits
    const tempPath = this.filePath + '.tmp';
    const input = fs.createReadStream(this.filePath);
    const output = fs.createWriteStream(tempPath);
    const decoder = new TextDecoder(this.encoding, { fatal: false });
    
    let lineNumber = -1;
    let buffer = '';
    
    return new Promise((resolve, reject) => {
      input.on('data', (chunk) => {
        if (typeof chunk === 'string') {
          buffer += chunk;
        } else {
          const uint8Array = chunk instanceof Buffer ? new Uint8Array(chunk) : chunk;
          buffer += decoder.decode(uint8Array, { stream: true });
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          lineNumber++;
          const isHeader = lineNumber === 0 && this.hasHeaders;
          
          if (isHeader) {
            output.write(line + '\n');
          } else {
            const rowId = lineNumber - (this.hasHeaders ? 1 : 0);
            if (this.pendingEdits.has(rowId)) {
              const editedRow = this.pendingEdits.get(rowId)!;
              output.write(editedRow.join(this.delimiter) + '\n');
            } else {
              output.write(line + '\n');
            }
          }
        }
      });

      input.on('end', () => {
        if (buffer) {
          lineNumber++;
          const rowId = lineNumber - (this.hasHeaders ? 1 : 0);
          if (this.pendingEdits.has(rowId)) {
            const editedRow = this.pendingEdits.get(rowId)!;
            output.write(editedRow.join(this.delimiter));
          } else {
            output.write(buffer);
          }
        }
        output.end();
      });

      output.on('finish', async () => {
        await fs.promises.unlink(this.filePath);
        await fs.promises.rename(tempPath, this.filePath);
        this.pendingEdits.clear();
        this.editHistory = [];
        resolve();
      });

      input.on('error', reject);
      output.on('error', reject);
    });
  }

  public async saveEditsAs(destinationPath: string): Promise<void> {
    // Similar to saveEdits but writes to a different location
    const input = fs.createReadStream(this.filePath);
    const output = fs.createWriteStream(destinationPath);
    const decoder = new TextDecoder(this.encoding, { fatal: false });
    
    let lineNumber = -1;
    let buffer = '';
    
    return new Promise((resolve, reject) => {
      input.on('data', (chunk) => {
        if (typeof chunk === 'string') {
          buffer += chunk;
        } else {
          const uint8Array = chunk instanceof Buffer ? new Uint8Array(chunk) : chunk;
          buffer += decoder.decode(uint8Array, { stream: true });
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          lineNumber++;
          const isHeader = lineNumber === 0 && this.hasHeaders;
          
          if (isHeader) {
            output.write(line + '\n');
          } else {
            const rowId = lineNumber - (this.hasHeaders ? 1 : 0);
            if (this.pendingEdits.has(rowId)) {
              const editedRow = this.pendingEdits.get(rowId)!;
              output.write(editedRow.join(this.delimiter) + '\n');
            } else {
              output.write(line + '\n');
            }
          }
        }
      });

      input.on('end', () => {
        if (buffer) {
          lineNumber++;
          const rowId = lineNumber - (this.hasHeaders ? 1 : 0);
          if (this.pendingEdits.has(rowId)) {
            const editedRow = this.pendingEdits.get(rowId)!;
            output.write(editedRow.join(this.delimiter));
          } else {
            output.write(buffer);
          }
        }
        output.end();
      });

      output.on('finish', resolve);
      output.on('error', reject);
      input.on('error', reject);
    });
  }

  public async createBackup(backupPath: string): Promise<string> {
    const backupFile = backupPath + '.backup';
    await this.saveEditsAs(backupFile);
    return backupFile;
  }

  public undo(): { rowId: number, oldValues: string[], newValues: string[] } | null {
    if (this.editHistory.length === 0) {
      return null;
    }
    
    const lastEdit = this.editHistory.pop()!;
    this.pendingEdits.set(lastEdit.rowId, lastEdit.oldValues);
    
    return lastEdit;
  }

  public redo(): { rowId: number, oldValues: string[], newValues: string[] } | null {
    // For simplicity, we'll just return null for now
    // In a full implementation, we'd maintain separate redo history
    return null;
  }
}
