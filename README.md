# Neouxe

A local-first, browser-based design tool — think Figma-style layers, components,
design tokens, auto layout, and prototyping, running entirely client-side with
no backend or native shell.

## Features

- **Canvas editing** — shapes, frames, text, vectors/paths, and images with
  hit-testing, transforms, and rulers
- **Layers & pages** — multi-page documents with a layers panel
- **Components** — create components/instances, detach, and reset overrides
- **Auto layout** — flex-style layout with hug/fill sizing
- **Design tokens** — colors, typography, and theming with token binding
- **Vector editing** — path editing and SVG import/export
- **Prototyping** — link frames together and preview interactions
- **Code export** — generate code from designs (see `src/shared/codegen.ts`)
- **Multi-tab sessions** — each tab keeps its own document and undo/redo history
- **Local persistence** — autosave and crash recovery via `localStorage`; Open/Save
  uses the browser File System Access API where available, with download/file-picker
  fallbacks elsewhere

## Tech stack

- [React 19](https://react.dev/) + [Zustand](https://github.com/pmndrs/zustand) for state
- [Vite](https://vitejs.dev/) for dev server and bundling
- [TypeScript](https://www.typescriptlang.org/) throughout
- [Vitest](https://vitest.dev/) for testing

## Getting started

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**.

## Scripts

| Script              | What it does                                  |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Vite dev server with hot reload (port 5173)   |
| `npm run build`     | Static production build into `dist/renderer/` |
| `npm run preview`   | Serve the production build (port 4173)        |
| `npm run serve`     | Alias of `preview`                            |
| `npm run start`     | `build` + `preview` in one command             |
| `npm run typecheck` | Type-check the source with `tsc --noEmit`     |
| `npm test`          | Run the Vitest suite                          |

See [LOCAL_HOSTING.md](LOCAL_HOSTING.md) for details on running a persistent
local build, changing the port, and browser support for file Open/Save.

## Project structure

```
src/
  shared/       Document model, types, tokens, auto layout, codegen, prototype logic
  renderer/
    canvas/     Rendering, hit-testing, transforms, path/text layout
    components/ React UI (panels, toolbar, dialogs, overlays)
    constants/  Static config (frame presets, etc.)
    export/     Export pipeline
    io/         File I/O (open/save, image import)
    ipc/        In-browser document engine facade
    store/      Zustand stores (design state, preferences)
```

## Testing

```bash
npm test
```

Tests live alongside their source files as `*.test.ts` (see `src/shared` and
`src/renderer/canvas`).
