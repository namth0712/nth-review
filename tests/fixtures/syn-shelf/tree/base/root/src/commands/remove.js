import { store } from '../store.js';

// shelf remove <id>: removes a book. The finished total keeps it.
export function remove([id]) {
  const book = store.getBook(Number(id));
  if (!book) throw new Error(`No book with id ${id}.`);
  store.data.books = store.data.books.filter((other) => other.id !== book.id);
  store.save();
  console.log(`Removed ${book.title}.`);
}
