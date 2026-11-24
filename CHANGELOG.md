# changelog

all notable changes to moji are documented in this file.
the newest revision appears first.

## 0.0.1 — 2026-11-23

initial visual interface, extended into a functional editor: canvas, zoom and pan, emoji picker and placement, delete, undo/redo, recenter, png export, and automatic local saving.

### added

- `index.html`: document structure with mobile viewport settings (`viewport-fit=cover`), page title, and a visually hidden `moji` heading.
- `index.html`: Atkinson Hyperlegible (regular and bold) loaded from Google Fonts, with a system sans-serif fallback.
- `index.html`: workspace layer and a `<canvas>` stage drawn by `js/main.js`; `js/emoji-data.js` and `js/main.js` load in that order with `defer`; theme color set to the workspace gray.
- `index.html`: settings button (upper left) with a ⚙️ emoji icon and a right-pointing chevron suggesting future rightward expansion.
- `index.html`: tools button (upper right) with 🛠️ and a small chevron, expanding into a row of ➕ add, ➖ delete, ↩️ undo, ↪️ redo, 🎯 recenter, and ✅ export.
- `index.html`: compact timeline placeholder (bottom center) with a ⏳ emoji icon and an empty track; no history entries shown.
- `index.html`: `canvas` label (frosted glass, text) that follows the canvas's upper-left edge at a constant screen size.
- `index.html`: mode bar (bottom right) shown only during placement (➕ to reopen the picker, ✖️ to exit) or delete mode (✖️ to exit).
- `index.html`: canvas properties panel, emoji picker sheet, and a transient status message for export and autosave problems.
- `index.html`: emoji icons and chevrons marked decorative; controls have accessible names; ⚙️ and ⏳ are marked `aria-disabled="true"` because they are not yet functional.
- `css/styles.css`: design tokens as CSS custom properties for colors, glass material, blur, grid, spacing, safe areas, control dimensions, sheet heights, radii, motion, and z-index.
- `css/styles.css`: typography tokens (font family, sizes, weights, line heights, letter spacing), including a `--font-family-emoji` stack (Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Twemoji Mozilla).
- `css/styles.css`: global reset that prevents page scrolling and overscroll.
- `css/styles.css`: workspace background (`#D8DADC`) with a subtle 1px grid: secondary lines (`#D0D2D4`) and primary lines (`#C5C8CB`) every fifth line; the grid sits outside the canvas.
- `css/styles.css`: translucent glass material for all floating controls and panels: about 70% opaque light fill (80% for panels), 22px blur with increased saturation, a hairline edge and top highlight instead of borders, and soft layered shadows.
- `css/styles.css`: capsule-shaped controls 48px tall with 44px emoji touch targets; panels with 22–30px radii; pressed states that scale controls down slightly.
- `css/styles.css`: tools morph from a capsule into a wider capsule expanding to the left (340ms spring curve); 🛠️ stays pinned in place, the chevron rotates to show whether the panel will expand or collapse, and tools fade and slide in one after another, nearest first.
- `css/styles.css`: on narrow screens where the expanded tools reach the settings corner, ⚙️ fades aside while the tools are open and returns when they close; it never moves.
- `css/styles.css`: canvas properties as a compact popover with a segmented aspect-ratio control and inline width × height fields.
- `css/styles.css`: emoji picker as a floating sheet rising from the bottom, about a third of the screen when compact and expandable to just below the top controls; a search capsule with an icon and muted category icons share one row so the grid keeps most of the space.
- `css/styles.css`: floating control positioning anchored to corners and bottom center, respecting device safe areas, with responsive edge spacing and timeline width at 600px and 1024px.
- `css/styles.css`: visible keyboard focus outline (`:focus-visible`).
- `css/styles.css`: opaque fallback when `backdrop-filter` is unsupported or reduced transparency is preferred; reduced-motion support that removes movement and keeps only quick fades; borders for forced-colors mode.
- `js/main.js`: document model in which every placed emoji is an independent object (id, emoji, render style, position in artwork coordinates, size, rotation, creation order, timestamp); array order is the stacking order. coordinates are centered on the canvas so canvas resizing never moves objects.
- `js/main.js`: action history of immutable, self-contained entries (`add-object`, `delete-object`, `resize-canvas`) that can each be applied and reverted; undo and redo move a cursor through the list, and a new action discards the redo branch.
- `js/main.js`: default 9:16 canvas (1080 × 1920 artwork px, `#FFFFFF`), fitted and centered between the top and bottom controls, with edges snapped to device pixels.
- `js/main.js`: zoom and pan that change only the view, never the artwork. touch: one finger taps, two fingers pan, pinch zooms. desktop: drag (left or middle button) pans; mouse wheel, trackpad scrolling, and trackpad pinch all zoom around the pointer. every wheel event zooms, instead of guessing whether it came from a mouse or a trackpad.
- `js/main.js`: stage rendering that redraws the white canvas and all objects from the document model each frame at the device pixel ratio, using the platform's native color emoji font; objects outside the canvas stay visible on the workspace.
- `js/main.js`: workspace grid kept aligned with the artwork while zooming and panning, with spacing adapting to stay visually quiet.
- `js/main.js`: tap detection that ignores pinches, multi-finger gestures, and drags, so gestures never place or delete emoji.
- `js/main.js`: tools panel behavior: 🛠️ toggles the panel; ➕ closes it and opens the picker; ➖ toggles delete mode and keeps the panel open; ↩️ and ↪️ undo and redo without closing the panel (dimmed when unavailable); 🎯 and ✅ act immediately without changing the current mode.
- `js/main.js`: 🎯 recenter, which smoothly returns the view to the fitted, centered canvas (instantly when reduced motion is preferred); it changes only the view and creates no history entry.
- `js/emoji-data.js`: the emoji catalog (1,369 emoji in nine categories, each with a searchable name), kept as a data-only file separate from the application logic in `js/main.js`; `js/main.js` reads it from `window.MOJI_EMOJI_CATEGORIES`.
- `js/main.js`: emoji picker with search (by unicode name), category navigation that follows scrolling, and a scrollable grid of 1,369 emoji (unicode 13.0 and earlier) across nine categories; selecting an emoji closes the picker and enters placement mode without placing anything.
- `js/main.js`: placement mode, where each tap places a new copy of the selected emoji at the tapped artwork position.
- `js/main.js`: delete mode, where each tap removes only the topmost emoji under the pointer (with a minimum touch radius for small emoji).
- `js/main.js`: canvas properties opened from the canvas label: aspect ratio presets (9:16, 4:5, 1:1, 3:4, 16:9) and custom width and height (64–4096 px); resizing is symmetric around the center, undoable, and never moves, scales, rotates, or removes objects. the popover opens above the label when there is room.
- `js/main.js`: one-tap png export: ✅ renders the png from the document model at the canvas's own pixel size, independent of zoom, and starts the browser's download directly, with no preview or dialog. only the canvas area is drawn, so the grid, interface, label, and objects outside the canvas are excluded and objects crossing the edge are cropped. failures show a brief message.
- `js/main.js`: automatic local saving of the structured project (canvas, objects, and undo/redo history) to `localStorage`, about 0.4s after each change (placement, deletion, canvas resize, undo, redo) and when the page is hidden. if storage is full, the artwork is saved without history.
- `js/main.js`: automatic restore on startup, validated before use and without creating history entries; damaged history is dropped while the artwork is kept. a project that cannot be restored is copied to a backup key (`moji.project.unrestored`) before anything new is saved; if no backup can be made, autosave pauses for the session.
- `js/main.js`: escape key closes an open panel, then exits the current mode, then collapses the tools panel; ios page-zoom gestures and the stage context menu are suppressed.
- `README.md`: project description, how to run it, current features, emoji rendering notes, and a note that local browser storage is not a backup.
- `CHANGELOG.md`: changelog structure and this entry.
