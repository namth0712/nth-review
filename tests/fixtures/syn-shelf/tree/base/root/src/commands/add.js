import { store } from '../store.js';

// shelf add <pages> <title...>: adds a book.
export function add([pagesArg, ...titleWords]) {
  const pages = Number(pagesArg);
  const title = titleWords.join(' ').trim();
  if (!Number.isInteger(pages) || pages < 1) throw new Error('The page count must be a whole number of at least 1.');
  if (!title) throw new Error('A book needs a title.');
  const book = store.addBook({ title, pages });
  store.save();
  console.log(`Added ${book.id}: ${book.title} (${book.pages} pages).`);
}
