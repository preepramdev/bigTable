import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { CsvEngine } from './csvEngine';

async function writeCsvWithBackpressure(filePath: string, numRows: number, colsCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    
    // Construct 120 column headers
    const colHeaders: string[] = ['id'];
    for (let c = 1; c < colsCount; c++) {
      colHeaders.push(`col${c}`);
    }
    writeStream.write(colHeaders.join(',') + '\n');

    let i = 1;
    const chunkSize = 10000; // Safe chunk size (~2.5MB per write)

    writeStream.on('error', (err) => {
      reject(err);
    });

    function flow() {
      let ok = true;
      while (i <= numRows && ok) {
        let chunk: string[] = [];
        const end = Math.min(i + chunkSize - 1, numRows);
        
        for (; i <= end; i++) {
          const rowVals: string[] = [i.toString()];
          
          if (i === 999999) {
            // Target search term in column 60 near the very end
            for (let c = 1; c < colsCount; c++) {
              if (c === 60) {
                rowVals.push('TargetRow');
              } else {
                rowVals.push(c.toString());
              }
            }
          } else if (i === 500000) {
            // Inject UTF-8 international text and emojis
            for (let c = 1; c < colsCount; c++) {
              if (c === 1) rowVals.push('สวัสดีครับ 🙏 (Thai)');
              else if (c === 2) rowVals.push('こんにちは 🇯🇵 (Japanese)');
              else if (c === 3) rowVals.push('你好 🇨🇳 (Chinese)');
              else if (c === 4) rowVals.push('🚀 Rocket Emoji 🔥');
              else rowVals.push(c.toString());
            }
          } else {
            for (let c = 1; c < colsCount; c++) {
              rowVals.push(c.toString());
            }
          }
          
          chunk.push(rowVals.join(','));
        }

        ok = writeStream.write(chunk.join('\n') + '\n');
        
        if ((i - 1) % 1000000 === 0 || i > numRows) {
          console.log(`[Gen Progress] Generated ${Math.min(i - 1, numRows)} rows...`);
        }
      }

      if (i <= numRows) {
        // Paused due to backpressure, wait for drain to continue
        writeStream.once('drain', flow);
      } else {
        writeStream.end();
      }
    }

    writeStream.on('finish', () => {
      resolve();
    });

    flow();
  });
}

async function runTest() {
  const testFile = path.join(__dirname, 'test.csv');
  const numRows = 1000000;
  const colsCount = 120;

  console.log(`Generating test CSV file with ${numRows.toLocaleString()} rows and ${colsCount} columns...`);
  
  const genStart = performance.now();
  await writeCsvWithBackpressure(testFile, numRows, colsCount);
  const fileSizeInBytes = fs.statSync(testFile).size;
  const fileSizeInGigabytes = (fileSizeInBytes / (1024 * 1024 * 1024)).toFixed(2);
  const genEnd = performance.now();
  console.log(`CSV file generated successfully. Size: ${fileSizeInGigabytes} GB. Time taken: ${((genEnd - genStart) / 1000).toFixed(2)}s\n`);

  const engine = new CsvEngine(testFile, (count, complete) => {
    if (complete || count % 1000000 === 0) {
      console.log(`[Progress] Rows indexed: ${count.toLocaleString()}, complete: ${complete}`);
    }
  });

  console.log('Starting indexing...');
  const indexStart = performance.now();
  await engine.startIndexing();
  const indexEnd = performance.now();
  console.log(`Indexing complete in ${(indexEnd - indexStart).toFixed(2)}ms. Total rows: ${engine.getTotalRows().toLocaleString()}`);
  console.log(`Total Columns: ${engine.getHeaders().length}`);

  console.log('\n--- Reading Page 500,000 (size 5) from middle of file ---');
  const readStart = performance.now();
  const pageMiddle = await engine.readPage(500000, 5);
  const readEnd = performance.now();
  console.log(`Read page took ${(readEnd - readStart).toFixed(2)}ms:`);
  console.log(pageMiddle.map(r => r.slice(0, 5).join(',') + `, ... (+115 cols)`));

  console.log('\n--- Searching for "TargetRow" (near the end of file, row 999,999) ---');
  const searchStart = performance.now();
  const searchResult = await engine.search('TargetRow', 5);
  const searchEnd = performance.now();
  console.log(`Search took ${(searchEnd - searchStart).toFixed(2)}ms:`);
  console.log('Search Result rows (first 3 columns shown):', searchResult.rows.map(r => r.slice(0, 3).join(',') + ` ... col60: ${r[60]} ...`));

  console.log('\n--- Searching for Thai "สวัสดี" ---');
  const thaiSearch = await engine.search('สวัสดี', 5);
  console.log('Thai search result rows (first 5 columns):', thaiSearch.rows.map(r => r.slice(0, 5)));

  console.log('\n--- Searching for emoji "🚀" ---');
  const emojiSearch = await engine.search('🚀', 5);
  console.log('Emoji search result rows (first 5 columns):', emojiSearch.rows.map(r => r.slice(0, 5)));

  // Clean up
  fs.unlinkSync(testFile);
  console.log('\nTest completed successfully and test file cleaned up.');
}

runTest().catch(console.error);
