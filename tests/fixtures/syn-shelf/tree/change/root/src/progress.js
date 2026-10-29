// How far a book has been read, as a whole percent rounded down:
// 199 of 200 pages shows as 99%.
export function percent(book) {
  const readTimesHundred = book.currentPage * 100;
  const pageCount = book.pages;

  return Math.floor(readTimesHundred / pageCount);
}
