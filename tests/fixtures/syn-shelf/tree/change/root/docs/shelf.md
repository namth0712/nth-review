# Shelf rules

## Books

- A book has a title and a page count.
- The page count is a whole number of at least 1. A book without one is refused, whether it is added by hand or imported.
- Each book gets a numeric id when it is added. Commands take that id.

## Finishing a book

- A finished book records the day it was finished.
- A book is finished once. Finishing it again is refused.

## Reading progress

- `shelf progress <id> <page>` records the page you have reached. The page is a whole number from 0, or a percentage such as `40%`.
- A page past the last page counts as the last page.
- A book is finished when its current page reaches its page count. Shelf then records it as finished, as `shelf finish` does.
- Progress on a finished book changes its page only: the book stays finished.
- `shelf list` shows each unfinished book's progress as a whole percent, rounded down.
- `shelf list --sort progress` lists books by progress, the highest percent first.

## Statistics

- The finished total counts each book once, however its finishing was recorded.
- Removing a book does not change the finished total.

## Storage

- The list is one JSON file, `~/.shelf.json`.
- Shelf is single-user: one command runs at a time.
