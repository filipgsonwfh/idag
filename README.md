# Idag

A start page over my Linear backlog (team PO). Static HTML, no build step, served from GitHub Pages.
Shows every open issue in the team, grouped by workflow state (In Progress first, then Todo, then
Backlog), oldest first with age in days. Each row can be moved to Done, Backlog or Canceled straight
from the page, with undo.

The page talks to Linear's GraphQL API directly from the browser with a personal API key.
The key lives in `localStorage` only. Nothing is stored in this repo.

## Setup

1. Create a public repo named `idag`, push this folder, enable Pages (branch `main`, folder `/`).
2. Open <https://filipgsonwfh.github.io/idag/> and paste a Linear personal API key
   (Linear → Settings → Security & access → Personal API keys).
3. Chrome: `chrome://extensions` → Developer mode → Load unpacked → the `extension/` folder.
   New tabs now open the page. If the URL changes, edit `extension/newtab.js`.
4. iPhone: open the URL in Safari → Share → Add to Home Screen.

## What it marks

- "Visa" in the settings picks what the page shows: everything in the team, issues without a project, or one project. "Skapa ny" creates in the selected project.
- Stale: In Progress older than 7 days, Todo older than 14.
- The description shows under the title, two lines; click it for the whole text. Empty description: "saknar kontext".
- "Skapa ny" (or `c`) creates an issue in the team; a line of context is required, state defaults to Todo.

## Deploying

GitHub Pages caches files for ten minutes, so a new `index.html` can meet an old `app.js` in the
browser. The asset links in `index.html` carry a `?v=N` query string: bump it whenever `app.js` or
`styles.css` change.

## Development

```sh
python3 -m http.server 8765        # open http://localhost:8765/?demo for mock data
npx -p typescript tsc -p .         # type-check app.js (JSDoc types)
node scripts/icons.mjs             # regenerate the PNG icons
```
