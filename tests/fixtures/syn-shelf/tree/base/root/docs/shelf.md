# Shelf rules

## Books

- A book has a title and a page count.
- The page count is a whole number of at least 1. A book without one is refused, whether it is added by hand or imported.
- Each book gets a numeric id when it is added. Commands take that id.

## Finishing a book

- A finished book records the day it was finished.
- A book is finished once. Finishing it again is refused.

## Statistics

- The finished total counts each book once, however its finishing was recorded.
- Removing a book does not change the finished total.

## Storage

- The list is one JSON file, `~/.shelf.json`.
- Shelf is single-user: one command runs at a time.
