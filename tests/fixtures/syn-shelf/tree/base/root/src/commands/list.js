import { store } from '../store.js';

// shelf list: one line per book, in the order they were added.
export function list() {
  const books = store.data.books;
  if (!books.length) {
    console.log('Your shelf is empty.');
    return;
  }
  for (const book of books) {
    const state = book.finishedAt ? `finished ${book.finishedAt}` : `${book.pages} pages`;
    console.log(`${String(book.id).padStart(3)}  ${book.title}  (${state})`);
  }
}
