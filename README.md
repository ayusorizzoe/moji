# moji

a mobile-first, browser-based editor for emoji art.

## running

moji is plain html, css, and javascript with no build step or dependencies.
open `index.html` in a browser, or serve the folder locally, for example:

```
python3 -m http.server
```

## current features (0.0.3, in progress)

- a 9:16 black canvas on a gray grid workspace. on phones the canvas fills the screen; pinch to zoom out and see all of it.
- touch: pinch to zoom, two fingers to pan, one finger to tap.
- desktop: drag to pan; scroll wheel, trackpad scrolling, or trackpad pinch to zoom around the pointer.
- tap the `canvas` label (a round button beside ⚙️ while the canvas fills the screen, a label just above the canvas once zoomed out) to change the aspect ratio, set a custom size, or pick a background color (simple swatches, or the color wheel for any color). resizing never moves or scales emoji.
- 🛠️ opens the tools: ➕ add, ➖ delete, ↩️ undo, ↪️ redo, 🗂️ layers, 🎯 recenter, ✅ export.
- ➕ opens the emoji picker (search and categories). pick an emoji, then tap to place copies. while placing, the emoji hangs in a tab under ➕: tap it to change emoji, or tap ➕ again to stop.
- ➖ enters delete mode: tap an emoji to remove it. 🧹 in the tab under ➖ deletes every emoji at once (↩️ brings them back). tap ➖ again to stop.
- tapping any button briefly shows its name right next to it.
- 🎯 brings the whole canvas back into view.
- ✅ downloads a png at the canvas's own size. emoji may be placed outside the canvas; only the canvas area is exported.
- your project saves automatically in this browser and reopens when you return.

### editing your artwork

- tap an emoji to select it (nothing moves). tap the same spot again to reach emoji underneath. tap empty space to deselect. on touch screens a white outline follows the emoji's shape; with a mouse it gets a box.
- drag a selected emoji to move it right away. press and hold an unselected emoji to start editing it (the outline turns blue), then drag to move it. while editing, drag again any time; use two fingers on it to resize and rotate, or with a mouse drag the corner handle to resize and the top handle to rotate. the controls fade away while you move things.
- select several: shift-click on desktop; on touch, rest one finger on empty space and tap emoji with another finger.
- while editing, tap the selection for its menu: duplicate, group, ungroup, to front, forward, backward, to back.

### layers

- 🗂️ opens the layers panel: every emoji and group, frontmost first. it stays open while you work until you close it with ✕.
- tap a row to select that emoji (shift-click adds more on desktop). the eye hides an emoji (hidden emoji don't export); the lock keeps it from being selected, moved or deleted on the canvas.
- groups are folders: tap the arrow to see their members, and select, hide or lock one member without ungrouping.
- drag a row by its grip (≡) to restack it, or into, out of, or between groups. the canvas follows as you drag; escape cancels.
- emoji outside the canvas are hidden while the canvas fills the screen, and show faintly once you zoom out. exports always crop to the canvas.

### timeline

- the strip next to ⏳ shows your history as you work, one tick per change. drag it, or tap ⏳, to open the timeline.
- in the open timeline, drag the playhead to see any earlier moment (your current artwork is not changed), or press ▶️ to watch it being made, mistakes and corrections included. the speed button switches between 0.5×, 1×, 2× and 4×.
- 🌱 start from here (shown while looking at an earlier moment) starts a new branch from that moment; your original history is kept.
- 🌿 lists branches to switch between, rename, or delete. a project can have up to five branches.
- reset erases every step and branch and keeps the current artwork as the new start (tap it twice; it cannot be undone). to start blank, delete all with 🧹 first, then reset.
- tap ⏳ again, or tap anywhere outside the timeline, to close; you return to the latest state of the current branch.

⚙️ settings is a placeholder and not yet functional.

## saving

projects are saved automatically to this browser's local storage, including every branch and its history.
projects from 0.0.1 are converted the first time they open; the original data is kept as a backup in the same storage.
local storage is not a backup: it stays on this device and browser only, and the browser or
you can clear it (for example by clearing site data or using private browsing). export a png
to keep a copy of your artwork.

## emoji rendering

emoji are drawn with the device's own color emoji font, so they look like apple emoji on iphone, ipad, and mac, and use the platform's own emoji design elsewhere (for example noto on android, segoe on windows). no emoji artwork is bundled.
