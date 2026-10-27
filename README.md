# Idag

A start page over my Linear backlog (team PO). Static HTML, no build step, served from GitHub Pages.
Shows what is in progress, this week's Todo (oldest first, with age in days) and how much is waiting
in Backlog. Each row can be moved to Done, Backlog or Canceled straight from the page, with undo.

The page talks to Linear's GraphQL API directly from the browser with a personal API key.
The key lives in `localStorage` only. Nothing is stored in this repo.

## Setup

1. Create a public repo named `idag`, push this folder, enable Pages (branch `main`, folder `/`).
2. Open <https://filipgsonwfh.github.io/idag/> and paste a Linear personal API key
   (Linear → Settings → Security & access → Personal API keys).
3. Chrome: `chrome://extensions` → Developer mode → Load unpacked → the `extension/` folder.
   New tabs now open the page. If the URL changes, edit `extension/newtab.js`.
4. iPhone: open the URL in Safari → Share → Add to Home Screen.

## Rules the page encodes

- Todo is a promise: more than 7 turns the counter red.
- Stale: Todo older than 14 days, In Progress older than 7.
- More than 5 stale: "dags för veckorensningen".
- Empty description: "saknar kontext".

## Development

```sh
python3 -m http.server 8765        # open http://localhost:8765/?demo for mock data
npx -p typescript tsc -p .         # type-check app.js (JSDoc types)
node scripts/icons.mjs             # regenerate the PNG icons
```
