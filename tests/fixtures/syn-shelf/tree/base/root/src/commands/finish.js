import { bus } from '../events.js';
import { store, today } from '../store.js';

// shelf finish <id>: marks a book as finished.
export function finish([id]) {
  const book = store.getBook(Number(id));
  if (!book) throw new Error(`No book with id ${id}.`);
  if (book.finishedAt) throw new Error(`${book.title} was already finished on ${book.finishedAt}.`);

  book.currentPage = book.pages;
  book.finishedAt = today();
  store.save();
  bus.emit('book.finished', book);
  console.log(`Finished ${book.title}.`);
}
