# moji

a mobile-first, browser-based editor for emoji art.

## running

moji is plain html, css, and javascript with no build step or dependencies.
open `index.html` in a browser, or serve the folder locally, for example:

```
python3 -m http.server
```

## current features (0.0.1)

- a 9:16 white canvas on a gray grid workspace.
- touch: pinch to zoom, two fingers to pan, one finger to tap.
- desktop: drag to pan; scroll wheel, trackpad scrolling, or trackpad pinch to zoom around the pointer.
- tap the `canvas` label to change the aspect ratio or set a custom size. resizing never moves or scales emoji.
- 🛠️ opens the tools: ➕ add, ➖ delete, ↩️ undo, ↪️ redo, 🎯 recenter, ✅ export.
- ➕ opens the emoji picker (search and categories). pick an emoji, then tap to place copies; use the floating ➕ to switch emoji and ✖️ to stop placing.
- ➖ enters delete mode: tap an emoji to remove it.
- 🎯 brings the whole canvas back into view.
- ✅ downloads a png at the canvas's own size. emoji may be placed outside the canvas; only the canvas area is exported.
- your project saves automatically in this browser and reopens when you return.

⚙️ settings and the ⏳ timeline are placeholders and not yet functional.

## saving

projects are saved automatically to this browser's local storage, including undo history.
local storage is not a backup: it stays on this device and browser only, and the browser or
you can clear it (for example by clearing site data or using private browsing). export a png
to keep a copy of your artwork.

## emoji rendering

emoji are drawn with the device's own color emoji font, so they look like apple emoji on iphone, ipad, and mac, and use the platform's own emoji design elsewhere (for example noto on android, segoe on windows). no emoji artwork is bundled.
