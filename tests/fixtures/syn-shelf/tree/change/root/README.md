# Shelf

Shelf keeps a personal reading list on your own computer. It is a single-user
command-line tool: one command runs at a time, and the list lives in one JSON
file in your home folder.

## Commands

| Command | What it does |
| --- | --- |
| `shelf add <pages> <title>` | Adds a book with its page count. |
| `shelf list [--sort progress]` | Lists your books and how far you have read. |
| `shelf progress <id> <page>` | Records the page you have reached. |
| `shelf finish <id>` | Marks a book as finished. |
| `shelf remove <id>` | Removes a book. |
| `shelf stats` | Shows how many books you have finished. |

To add many books at once, run `npm run import -- books.csv` with a CSV file
whose columns are `title,pages`.

The rules Shelf follows are in [docs/shelf.md](docs/shelf.md).
