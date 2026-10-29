import { bus } from '../events.js';
import { store, today } from '../store.js';

// shelf progress <id> <page>: records the page reached in a book.
export function progress([id, pageArg]) {
  const book = store.getBook(Number(id));
  if (!book) {
    throw new Error(`No book with id ${id}.`);
  }

  const page = Number(pageArg);
  if (!Number.isInteger(page) || page < 0) {
    throw new Error('The page must be a whole number from 0.');
  }

  book.currentPage = Math.min(page, book.pages);
  store.save();
  console.log(`${book.title}: page ${book.currentPage} of ${book.pages}.`);

  if (page > book.pages) {
    recordFinish(book);
  }
}

// A finished book gets its finishing day, and plugins hear about it.
function recordFinish(book) {
  book.finishedAt = today();
  store.save();
  console.log(`Finished ${book.title}.`);

  bus.emit('book.finished', book);
}
