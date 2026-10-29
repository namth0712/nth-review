import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.shelf.json');
const EMPTY = { nextId: 1, books: [], stats: { finishedCount: 0 } };

// The reading list, kept in one JSON file. Book ids are numbers.
export const store = {
  data: structuredClone(EMPTY),

  load() {
    this.data = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : structuredClone(EMPTY);
  },

  save() {
    fs.writeFileSync(FILE, `${JSON.stringify(this.data, null, 2)}\n`);
  },

  getBook(id) {
    return this.data.books.find((book) => book.id === id);
  },

  addBook({ title, pages }) {
    const book = { id: this.data.nextId, title, pages, currentPage: 0, finishedAt: null };
    this.data.nextId += 1;
    this.data.books.push(book);
    return book;
  },
};

// The local date, as YYYY-MM-DD.
export function today() {
  return new Date().toLocaleDateString('sv-SE');
}
