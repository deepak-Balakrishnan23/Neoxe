# Running Neouxe Locally

Neouxe is a pure browser-based web app — its UI, canvas, document engine, and
state all run in the browser. There is **no Electron, no native shell, and no
backend**. You build a set of static files and serve them on a local port.

## What you need

- [Node.js](https://nodejs.org) 18+ and npm
- A Chromium-based browser (Chrome, Edge, Brave) is recommended for full
  Open/Save support — see [File handling](#file-handling).

## Quick start (development)

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. This runs the Vite dev server with hot reload —
best for development.

## Production local hosting

To build a static bundle and serve it persistently on a fixed port:

```bash
npm run start          # builds, then serves at http://localhost:4173
```

Or run the two steps separately:

```bash
npm run build          # outputs a static site to dist/renderer/
npm run preview        # serves dist/renderer/ at http://localhost:4173
```

The server runs on the fixed port `4173` (configured in
[`vite.config.ts`](vite.config.ts) under `preview`) and is exposed on your local
network, so other machines can reach it at `http://<your-ip>:4173`.

## Available scripts

| Script              | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Vite dev server with hot reload (port 5173)             |
| `npm run build`     | Static production build into `dist/renderer/`           |
| `npm run preview`   | Serve the production build (port 4173)                  |
| `npm run serve`     | Alias of `preview`                                      |
| `npm run start`     | `build` + `preview` in one command                      |
| `npm run typecheck` | Type-check the source with `tsc --noEmit`               |
| `npm test`          | Run the Vitest suite                                    |

## How it works

| Concern     | Behavior                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| App logic   | The document engine runs entirely in the renderer (`src/renderer/mockEngine.ts`).   |
| Persistence | Autosave, crash recovery, and recent files use **`localStorage`** (`src/renderer/persistence.ts`). No server-side storage. |
| Open / Save | Uses the browser **File System Access API** when available, with `<input type=file>` / download fallbacks (`src/renderer/io/fileIO.ts`). |

Because all data lives in `localStorage` and in files you explicitly open/save,
**no backend or database is required**.

## File handling

- **Chrome / Edge / Brave**: full native Open and Save via OS dialogs (File
  System Access API). Re-saving overwrites the same file with no prompt.
- **Firefox / Safari**: Open works via a file picker; **Save** is not supported
  (these browsers lack the File System Access API). Exports fall back to a normal
  download. Use a Chromium browser if you need in-place Save.

## Serving on a different port

Edit the `preview` block in [`vite.config.ts`](vite.config.ts):

```ts
preview: {
  port: 4173,      // change this
  host: true,      // set false to restrict to localhost only
  strictPort: true,
},
```

Or override at the command line:

```bash
npm run preview -- --port 8080
```

## Running persistently / as a background service

`npm run preview` runs in the foreground. To keep it running, use any process
manager, e.g.:

```bash
npx pm2 start "npm run preview" --name neouxe
```

The build in `dist/renderer/` is fully static, so it can also be served by any
static file server (nginx, `npx serve dist/renderer`, etc.).
