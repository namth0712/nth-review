// npm run import -- <file.csv>: adds every book of a CSV file with the columns title,pages.
// A title may contain commas: the page count is the last column.
import fs from 'node:fs';
import { store } from '../src/store.js';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run import -- <file.csv>');
  process.exit(1);
}

store.load();
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter((line) => line.trim());
let added = 0;
for (const [index, line] of rows.entries()) {
  const comma = line.lastIndexOf(',');
  const title = comma > 0 ? line.slice(0, comma).trim() : '';
  const pages = Number(line.slice(comma + 1));
  if (!title || !Number.isInteger(pages) || pages < 1) {
    console.error(`Line ${index + 2} skipped: it needs a title and a page count of at least 1.`);
    continue;
  }
  store.addBook({ title, pages });
  added += 1;
}
store.save();
console.log(`Imported ${added} of ${rows.length} books.`);
