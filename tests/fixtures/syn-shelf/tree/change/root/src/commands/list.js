import { percent } from '../progress.js';
import { store } from '../store.js';

// shelf list [--sort progress]: one line per book, in the order they were
// added, or by progress with --sort progress.
export function list(args) {
  const books = [...store.data.books];
  if (!books.length) {
    console.log('Your shelf is empty.');
    return;
  }
  if (args[0] === '--sort' && args[1] === 'progress') {
    books.sort((a, b) => b.currentPage - a.currentPage);
  }

  for (const book of books) {
    const state = book.finishedAt ? `finished ${book.finishedAt}` : `${percent(book)}% of ${book.pages} pages`;
    console.log(`${String(book.id).padStart(3)}  ${book.title}  (${state})`);
  }
}
