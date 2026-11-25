/* ==========================================================================
   moji: editor (0.0.2)

   structure
   1. configuration
   2. document model
   3. history (backed by js/history.js)
   4. view (zoom and pan)
   5. emoji rendering
   6. stage rendering
   7. editing operations
   7b. selection and transforms
   7c. object menu, grouping and stacking
   8. modes
   8b. tools shape and drop-down
   9. panels
   10. tools panel
   11. canvas properties
   12. emoji picker
   13. export
   14. stage input (tap, long press, drag, pinch, pan, wheel)
   15. keyboard and global guards
   16. autosave (local persistence)
   17. timeline (scrubbing, playback, branches)
   18. caption and toast
   19. startup
   20. emoji data
   ========================================================================== */

(function () {
  'use strict';


  /* 1. configuration
     ======================================================================== */

  const H = window.MojiHistory;

  const DEFAULT_CANVAS = { width: 1080, height: 1920, background: '#000000' };
  const CANVAS_MIN_SIZE = 64;
  const CANVAS_MAX_SIZE = 4096;          // keeps exports within mobile canvas limits

  const DEFAULT_EMOJI_SIZE = 120;        // artwork px (font size of a placed emoji)
  const MIN_EMOJI_SIZE = 8;              // artwork px limits for resizing
  const MAX_EMOJI_SIZE = 4000;
  const RENDER_STYLE_NATIVE = 'native';  // the platform's own color emoji font

  const GRID_WORLD_STEP = 120;           // artwork px between minor grid lines at base level
  const GRID_MIN_SCREEN_STEP = 24;       // screen px; grid steps are kept within [24, 120)
  const GRID_MAJOR_EVERY = 5;

  const TAP_SLOP = 8;                    // screen px a pointer may travel and still count as a tap
  const MIN_HIT_RADIUS = 22;             // screen px, so tiny emoji stay reachable by touch
  const LONG_PRESS_MS = 420;             // hold this long on an emoji to start editing
  const CYCLE_RADIUS = 18;               // screen px: repeated taps this close cycle through overlaps
  const MULTI_TAP_MS = 450;              // a second-finger tap must lift within this time
  const SELECTION_PAD = 6;               // screen px around the selection outline
  const MIN_FRAME_SIZE = 44;             // screen px: the outline never draws smaller than this
  const HANDLE_RADIUS = 22;              // screen px touch target of a transform handle
  const HANDLE_DOT = 6.5;                // screen px visible handle radius
  const ROTATE_HANDLE_OFFSET = 28;       // screen px above the outline

  const ZOOM_MIN_FACTOR = 0.1;           // relative to the fit scale
  const ZOOM_MAX_FACTOR = 40;
  const PANEL_HIDE_DELAY = 400;          // ms; matches the css sheet/panel transitions
  const RECENTER_DURATION = 420;         // ms
  const WHEEL_ZOOM_SPEED = 0.0018;       // per wheel delta pixel
  const PINCH_ZOOM_SPEED = 0.01;         // per ctrl+wheel delta pixel (trackpad pinch)

  const PLAYBACK_STEP_MS = 700;          // ms per event at 1× (a steady rhythm, not real time)
  const PLAYBACK_SPEEDS = [0.5, 1, 2, 4];

  const STORAGE_KEY = 'moji.project';
  const STORAGE_BACKUP_KEY = 'moji.project.unrestored';
  const STORAGE_V1_BACKUP_KEY = 'moji.project.v1-backup';
  const SAVE_DELAY = 400;                // ms of quiet before an autosave write

  const reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };


  /* 2. document model
     ------------------------------------------------------------------------
     the artwork is a list of independent objects. nothing is ever flattened
     into a bitmap: the stage and the export are both redrawn from this data.

     coordinates are artwork pixels with the origin at the canvas center, so
     resizing the canvas symmetrically never moves any object.

     emoji object fields:
       id           stable unique identifier
       type         'emoji'
       emoji        the emoji character sequence
       renderStyle  rendering style identifier ('native')
       x, y         center position in artwork coordinates
       size         font size in artwork px (uniform scale)
       rotation     radians
       order        creation order (monotonic)
       createdAt    timestamp (ms)
       groupId      optional: objects sharing a groupId form one group

     array order of doc.objects is the stacking order (last = topmost).
     objects are never changed in place: every edit makes new objects, so
     history snapshots can safely share them.

     doc is the live state of the active branch: its artwork plus its
     undo and redo stacks (see js/history.js).
     ======================================================================== */

  const doc = {
    canvas: { ...DEFAULT_CANVAS },
    objects: [],
    undo: [],
    redo: [],
  };

  let project = null;
  let nextOrder = 1;

  function createId(prefix) {
    return H.createId(prefix);
  }

  function createEmojiObject(emoji, x, y) {
    return {
      id: createId('obj'),
      type: 'emoji',
      emoji,
      renderStyle: RENDER_STYLE_NATIVE,
      x,
      y,
      size: DEFAULT_EMOJI_SIZE,
      rotation: 0,
      order: nextOrder++,
      createdAt: Date.now(),
    };
  }

  function findObjectIndex(id) {
    return doc.objects.findIndex((o) => o.id === id);
  }

  function setLiveState(state) {
    doc.canvas = state.canvas;
    doc.objects = state.objects;
    doc.undo = state.undo;
    doc.redo = state.redo;
  }

  // creation order continues after every object that exists in any branch
  function computeNextOrder() {
    let max = 0;
    const see = (o) => { if (o && o.order > max) max = o.order; };
    project.base.objects.forEach(see);
    project.branches.forEach((branch) => {
      branch.events.forEach((event) => {
        const op = event.op;
        if (!op) return;
        see(op.object);
        if (op.objects) op.objects.forEach(see);
      });
    });
    return max + 1;
  }


  /* 3. history
     ------------------------------------------------------------------------
     every edit is an operation recorded as an event on the active branch.
     undo and redo are events too, so the timeline shows the whole creative
     process. see js/history.js for the model.
     ======================================================================== */

  function recordEvent(event) {
    H.append(project, project.activeId, event);
    H.step(doc, event);
    onDocumentChanged();
  }

  function commit(op) {
    recordEvent(H.makeEvent('op', op));
  }

  function canUndo() {
    return doc.undo.length > 0;
  }

  function canRedo() {
    return doc.redo.length > 0;
  }

  function undo() {
    if (canUndo()) recordEvent(H.makeEvent('undo'));
  }

  function redo() {
    if (canRedo()) recordEvent(H.makeEvent('redo'));
  }


  /* 4. view (zoom and pan)
     ------------------------------------------------------------------------
     screen = artwork * scale + translate. the view never touches the
     document: zooming changes only how the artwork is displayed.
     ======================================================================== */

  const view = { scale: 1, tx: 0, ty: 0, fitScale: 1 };

  function worldToScreen(x, y) {
    return { x: x * view.scale + view.tx, y: y * view.scale + view.ty };
  }

  function screenToWorld(x, y) {
    return { x: (x - view.tx) / view.scale, y: (y - view.ty) / view.scale };
  }

  function canvasScreenRect() {
    const { width, height } = scene().canvas;
    const topLeft = worldToScreen(-width / 2, -height / 2);
    return { x: topLeft.x, y: topLeft.y, w: width * view.scale, h: height * view.scale };
  }

  function clampScale(scale) {
    const min = view.fitScale * ZOOM_MIN_FACTOR;
    const max = Math.max(view.fitScale * ZOOM_MAX_FACTOR, 8);
    return Math.min(max, Math.max(min, scale));
  }

  function zoomAt(sx, sy, factor) {
    const next = clampScale(view.scale * factor);
    const ratio = next / view.scale;
    view.tx = sx - (sx - view.tx) * ratio;
    view.ty = sy - (sy - view.ty) * ratio;
    view.scale = next;
    requestRender();
  }

  function panBy(dx, dy) {
    view.tx += dx;
    view.ty += dy;
    requestRender();
  }

  // phones: the canvas fills the whole screen behind the controls, like a
  // story. it covers the screen when that crops only a little (9:16 on a
  // tall phone); a shape far from the screen's own (1:1, 16:9) fits the
  // full width or height instead, so nothing important is cut off.
  const PHONE_MAX_SHORT_SIDE = 600;   // css px
  const PHONE_MAX_COVER_CROP = 1.3;   // cover scale / contain scale

  function isPhoneLayout() {
    return Math.min(viewportWidth, viewportHeight) < PHONE_MAX_SHORT_SIDE;
  }

  // the bottom of the top-row controls (layout offsets, unaffected by animations)
  function topControlsBottom() {
    return Math.max(dom.cornerBar.offsetTop + dom.cornerBar.offsetHeight,
      dom.toolsBar.offsetTop + dom.toolsBar.offsetHeight);
  }

  // the view that fits the whole canvas between the top and bottom controls
  // (on phones, the whole screen)
  function computeFitView() {
    const canvas = scene().canvas;
    if (isPhoneLayout() && viewportWidth && viewportHeight) {
      const contain = Math.min(viewportWidth / canvas.width, viewportHeight / canvas.height);
      const cover = Math.max(viewportWidth / canvas.width, viewportHeight / canvas.height);
      return {
        scale: cover / contain <= PHONE_MAX_COVER_CROP ? cover : contain,
        tx: viewportWidth / 2,
        ty: viewportHeight / 2,
      };
    }

    // layout offsets (not bounding rects) so control animations never affect the fit
    const corner = dom.cornerBar; // the upper-left corner control
    const tools = dom.toolsBar;
    const labelSpace = labelFullHeight + 6;

    const left = corner.offsetLeft;
    const right = tools.offsetLeft + tools.offsetWidth;
    const top = Math.max(corner.offsetTop + corner.offsetHeight,
      tools.offsetTop + tools.offsetHeight) + 8 + labelSpace;
    const bottom = dom.timelineBar.offsetTop - 12;

    const availW = Math.max(1, right - left);
    const availH = Math.max(1, bottom - top);
    return {
      scale: Math.min(availW / scene().canvas.width, availH / scene().canvas.height),
      tx: left + availW / 2,
      ty: top + availH / 2,
    };
  }

  function fitView() {
    cancelViewAnimation();
    const target = computeFitView();
    view.fitScale = target.scale;
    view.scale = target.scale;
    view.tx = target.tx;
    view.ty = target.ty;
    requestRender();
  }

  // smoothly return to the fitted, centered view. affects only the view:
  // no history entry, no change to the artwork.
  let viewAnimation = null;

  function cancelViewAnimation() {
    if (viewAnimation) cancelAnimationFrame(viewAnimation);
    viewAnimation = null;
  }

  function recenterView() {
    const target = computeFitView();
    view.fitScale = target.scale;
    cancelViewAnimation();

    if (reducedMotion.matches) {
      view.scale = target.scale;
      view.tx = target.tx;
      view.ty = target.ty;
      requestRender();
      return;
    }

    // world origin is the canvas center, so (tx, ty) is the canvas center on screen
    const from = { logScale: Math.log(view.scale), tx: view.tx, ty: view.ty };
    const to = { logScale: Math.log(target.scale), tx: target.tx, ty: target.ty };
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);

    const step = (now) => {
      const t = Math.min(1, (now - start) / RECENTER_DURATION);
      const e = ease(t);
      view.scale = Math.exp(from.logScale + (to.logScale - from.logScale) * e);
      view.tx = from.tx + (to.tx - from.tx) * e;
      view.ty = from.ty + (to.ty - from.ty) * e;
      requestRender();
      viewAnimation = t < 1 ? requestAnimationFrame(step) : null;
    };
    viewAnimation = requestAnimationFrame(step);
  }


  /* 5. emoji rendering
     ------------------------------------------------------------------------
     emoji are drawn with the platform's own color emoji font (apple color
     emoji on apple devices). glyphs are drawn fresh from the font at the
     exact on-screen or export size every time, never from a cached bitmap.
     ======================================================================== */

  let emojiFontFamily = 'sans-serif';
  const glyphMetrics = new Map();
  const measureContext = document.createElement('canvas').getContext('2d');

  // offsets that center each glyph's visible box on its position
  function getGlyphMetrics(emoji) {
    let metrics = glyphMetrics.get(emoji);
    if (metrics) return metrics;

    measureContext.font = '100px ' + emojiFontFamily;
    measureContext.textAlign = 'center';
    measureContext.textBaseline = 'alphabetic';
    const m = measureContext.measureText(emoji);
    const ascent = m.actualBoundingBoxAscent;
    const descent = m.actualBoundingBoxDescent;

    if (typeof ascent === 'number' && typeof descent === 'number' && ascent + descent > 0) {
      metrics = {
        baseline: 'alphabetic',
        dx: (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 200,
        dy: (ascent - descent) / 200,
      };
    } else {
      metrics = { baseline: 'middle', dx: 0, dy: 0 };
    }
    glyphMetrics.set(emoji, metrics);
    return metrics;
  }

  // the visible ink of each glyph, measured once from its pixels: center
  // offset and size in em units. measureText alone is not enough: some
  // browsers report the font's full em box for color emoji, so a wide or
  // short glyph (🏔️, 🚗) would sit off-center in its outline.
  const glyphInk = new Map();
  const INK_SIZE = 100;
  const INK_BOX = 256;
  const inkCanvas = document.createElement('canvas');
  inkCanvas.width = INK_BOX;
  inkCanvas.height = INK_BOX;
  const inkContext = inkCanvas.getContext('2d', { willReadFrequently: true });

  function getGlyphInk(emoji) {
    let ink = glyphInk.get(emoji);
    if (ink) return ink;
    ink = { cx: 0, cy: 0, w: 1, h: 1 };
    try {
      const metrics = getGlyphMetrics(emoji);
      const ctx = inkContext;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, INK_BOX, INK_BOX);
      ctx.font = INK_SIZE + 'px ' + emojiFontFamily;
      ctx.textAlign = 'center';
      ctx.textBaseline = metrics.baseline;
      ctx.fillStyle = '#000000';
      const c = INK_BOX / 2;
      ctx.fillText(emoji, c + metrics.dx * INK_SIZE, c + metrics.dy * INK_SIZE);
      const data = ctx.getImageData(0, 0, INK_BOX, INK_BOX).data;
      let minX = INK_BOX;
      let minY = INK_BOX;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < INK_BOX; y += 1) {
        for (let x = 0; x < INK_BOX; x += 1) {
          if (data[(y * INK_BOX + x) * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      // nothing drawn, or noise from canvas fingerprinting protection: keep
      // the plain em box
      if (maxX >= 0 && w < INK_BOX * 0.9 && h < INK_BOX * 0.9) {
        ink = {
          cx: ((minX + maxX + 1) / 2 - c) / INK_SIZE,
          cy: ((minY + maxY + 1) / 2 - c) / INK_SIZE,
          w: w / INK_SIZE,
          h: h / INK_SIZE,
        };
      }
    } catch (error) {
      // unreadable canvas: the em box is a fine fallback
    }
    glyphInk.set(emoji, ink);
    return ink;
  }

  // half the visible width and height of an object, in artwork px
  function objectHalfSize(object) {
    const ink = getGlyphInk(object.emoji);
    return { hw: (ink.w * object.size) / 2, hh: (ink.h * object.size) / 2 };
  }

  // draws one emoji object with its visible center at (cx, cy) and a font
  // size of px; rotation turns it around that visible center
  function drawEmoji(ctx, object, cx, cy, px) {
    if (px < 0.5) return;
    if (object.alpha !== undefined && object.alpha <= 0.01) return;
    const metrics = getGlyphMetrics(object.emoji);
    const ink = getGlyphInk(object.emoji);
    ctx.save();
    if (object.alpha !== undefined) ctx.globalAlpha *= Math.min(1, object.alpha);
    ctx.translate(cx, cy);
    if (object.rotation) ctx.rotate(object.rotation);
    ctx.font = px + 'px ' + emojiFontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = metrics.baseline;
    ctx.fillStyle = '#000000';
    ctx.fillText(object.emoji, (metrics.dx - ink.cx) * px, (metrics.dy - ink.cy) * px);
    ctx.restore();
  }


  /* 6. stage rendering
     ======================================================================== */

  const dom = {};
  let stageContext = null;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let pixelRatio = 1;
  let renderQueued = false;

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  let stageLeft = 0;
  let stageTop = 0;

  // match the stage's pixel buffer to its current css size. on ios safari the
  // stage height follows the dynamic viewport (100dvh), which changes as the
  // browser toolbars show and hide, often without a window resize event. a
  // buffer that no longer matches its css box is stretched by the browser,
  // which misplaces the drawing, taps, and zoom. returns true if it changed.
  function measureStage() {
    const width = dom.stage.clientWidth;
    const height = dom.stage.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    const rect = dom.stage.getBoundingClientRect();
    stageLeft = rect.left;
    stageTop = rect.top;
    if (width === viewportWidth && height === viewportHeight && ratio === pixelRatio) return false;

    const previousWidth = viewportWidth;
    const previousHeight = viewportHeight;
    viewportWidth = width;
    viewportHeight = height;
    pixelRatio = ratio;
    dom.stage.width = Math.round(width * ratio);
    dom.stage.height = Math.round(height * ratio);

    // keep the artwork centered where it was when the viewport changes
    if (previousWidth) {
      view.tx += (width - previousWidth) / 2;
      view.ty += (height - previousHeight) / 2;
    }
    return true;
  }

  function resizeStage() {
    measureStage();
    requestRender();
  }

  // pointer position relative to the stage, in css px
  function stagePoint(event) {
    return { x: event.clientX - stageLeft, y: event.clientY - stageTop };
  }

  // how visible artwork outside the canvas is: hidden while the canvas fills
  // the screen (the fitted phone view or closer), faint once zoomed out,
  // fading between the two as you pinch
  const OVERFLOW_FAINT = 0.3;
  let outsideAlpha = OVERFLOW_FAINT;

  function overflowAlpha(rect) {
    if (!viewportWidth || !viewportHeight) return OVERFLOW_FAINT;
    const fullness = Math.max(rect.w / viewportWidth, rect.h / viewportHeight);
    const t = Math.min(1, Math.max(0, (fullness - 0.85) / 0.13));
    return OVERFLOW_FAINT * (1 - t);
  }

  function render() {
    renderQueued = false;
    measureStage(); // safety net: never draw into a stretched buffer
    const ctx = stageContext;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dom.stage.width, dom.stage.height);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    // canvas surface, edges snapped to device pixels for a crisp boundary
    const rect = canvasScreenRect();
    const snap = (v) => Math.round(v * pixelRatio) / pixelRatio;
    const x0 = snap(rect.x);
    const y0 = snap(rect.y);
    const shown = scene();
    const x1 = snap(rect.x + rect.w);
    const y1 = snap(rect.y + rect.h);
    ctx.fillStyle = (shown === doc && backgroundPreview) || shown.canvas.background;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    // objects in stacking order, in two passes: fully inside the canvas,
    // then faintly (or not at all) outside it. the overflow mask is only
    // drawing: positions, hit testing and exports are unaffected.
    outsideAlpha = overflowAlpha(rect);
    const scale = view.scale;
    const visible = [];
    for (const object of shown.objects) {
      if (object.hidden) continue;
      const px = object.size * scale;
      const sx = object.x * scale + view.tx;
      const sy = object.y * scale + view.ty;
      if (sx + px < 0 || sx - px > viewportWidth || sy + px < 0 || sy - px > viewportHeight) continue;
      visible.push({ object, px, sx, sy, overflows: sx - px < x0 || sx + px > x1 || sy - px < y0 || sy + px > y1 });
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    visible.forEach((v) => drawEmoji(ctx, v.object, v.sx, v.sy, v.px));
    ctx.restore();
    if (outsideAlpha > 0.01 && visible.some((v) => v.overflows)) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, viewportWidth, viewportHeight);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip('evenodd');
      ctx.globalAlpha = outsideAlpha;
      visible.forEach((v) => { if (v.overflows) drawEmoji(ctx, v.object, v.sx, v.sy, v.px); });
      ctx.restore();
    }

    // selection outline and handles (interface only, never exported)
    if (!timeline.open && selection.ids.size) drawSelection(ctx);

    updateGrid();
    positionCanvasLabel(rect);
    if (openPanel === 'canvas') positionCanvasPanel();
    if (menuOpen) positionObjectMenu();
    if (layers.open) {
      renderLayers();
      positionLayersPanel();
    }
  }

  // keep the css grid aligned with the artwork origin at a quiet density
  function updateGrid() {
    let step = GRID_WORLD_STEP * view.scale;
    while (step < GRID_MIN_SCREEN_STEP) step *= GRID_MAJOR_EVERY;
    while (step >= GRID_MIN_SCREEN_STEP * GRID_MAJOR_EVERY) step /= GRID_MAJOR_EVERY;
    const major = step * GRID_MAJOR_EVERY;

    const mod = (a, n) => ((a % n) + n) % n;
    const mx = mod(view.tx, major);
    const my = mod(view.ty, major);
    const sx = mod(view.tx, step);
    const sy = mod(view.ty, step);

    dom.workspace.style.backgroundSize =
      `${major}px ${major}px, ${major}px ${major}px, ${step}px ${step}px, ${step}px ${step}px`;
    dom.workspace.style.backgroundPosition =
      `${mx}px ${my}px, ${mx}px ${my}px, ${sx}px ${sy}px, ${sx}px ${sy}px`;
  }

  let labelFullHeight = 30; // the label's height outside the canvas
  let labelMorphTimer = null;
  const labelState = { inside: null, width: '', miniW: '', miniH: '', miniBg: '' };

  function positionCanvasLabel(rect) {
    // outside, just above the canvas, when there is room below the top
    // controls; otherwise a round button in ⚙️'s place (⚙️ steps aside)
    const label = dom.canvasLabel;
    const morphing = label.classList.contains('is-morphing');
    if (!labelState.inside && !morphing && label.offsetHeight) labelFullHeight = label.offsetHeight;
    const inside = rect.y - labelFullHeight - 6 < topControlsBottom() + 6;

    if (labelState.inside !== inside) {
      // animate the move between the two places (not on the first layout)
      if (labelState.inside === null) {
        // first layout: take its place without animating
        label.style.transition = 'none';
        dom.cornerBar.style.transition = 'none'; // 🤔 too: no slide on page load
        requestAnimationFrame(() => requestAnimationFrame(() => {
          label.style.transition = '';
          dom.cornerBar.style.transition = '';
        }));
      } else if (!reducedMotion.matches) {
        label.classList.add('is-morphing');
        clearTimeout(labelMorphTimer);
        labelMorphTimer = setTimeout(() => label.classList.remove('is-morphing'), PANEL_HIDE_DELAY + 80);
      }
      labelState.inside = inside;
      label.dataset.inside = String(inside);
      // the round canvas button takes ⚙️'s place; ⚙️ returns with the label
      document.body.dataset.canvasButton = String(inside);
      updateToolsCover(); // 🤔 moved, so the tools may now reach it
    }

    // explicit widths so the capsule and the circle morph into each other
    const size = dom.cornerBar.offsetHeight;
    const width = inside ? size + 'px' : (dom.canvasLabelText.offsetWidth + 24) + 'px';
    if (labelState.width !== width) {
      labelState.width = width;
      label.style.width = width;
    }

    // the miniature: the canvas's shape and color, fitted in 22px
    const canvas = scene().canvas;
    const ratio = canvas.width / canvas.height;
    const miniW = Math.round(ratio >= 1 ? 22 : Math.max(8, 22 * ratio)) + 'px';
    const miniH = Math.round(ratio >= 1 ? Math.max(8, 22 / ratio) : 22) + 'px';
    const miniBg = (scene() === doc && backgroundPreview) || canvas.background;
    if (labelState.miniW !== miniW || labelState.miniH !== miniH || labelState.miniBg !== miniBg) {
      labelState.miniW = miniW;
      labelState.miniH = miniH;
      labelState.miniBg = miniBg;
      label.style.setProperty('--mini-w', miniW);
      label.style.setProperty('--mini-h', miniH);
      label.style.setProperty('--mini-bg', miniBg);
    }

    let x;
    let y;
    if (inside) {
      x = dom.cornerBar.offsetLeft;
      y = dom.cornerBar.offsetTop;
    } else {
      // stays on screen when the canvas's left edge is panned away
      x = Math.round(Math.max(rect.x, Math.min(8, rect.x + rect.w - parseFloat(width))));
      y = Math.round(rect.y - labelFullHeight - 6);
    }
    label.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const labelWidth = parseFloat(width);
    const labelHeight = inside ? size : labelFullHeight;

    // the tools drop-down may reach down over the label; the label then
    // steps aside (fades, never moves) until the drop-down folds away
    let covered = false;
    if (mode !== 'idle' && !dom.toolsDrop.hidden) {
      const drop = dom.toolsDrop.getBoundingClientRect();
      covered = x < drop.right + 4 && x + labelWidth > drop.left - 4 &&
        y < drop.bottom + 4 && y + labelHeight > drop.top - 4;
    }
    dom.canvasLabel.dataset.covered = String(covered);
  }


  /* 7. editing operations
     ======================================================================== */

  function placeEmoji(emoji, worldX, worldY) {
    const object = createEmojiObject(emoji, worldX, worldY);
    commit({ type: 'add-objects', label: 'add', objects: [object], indices: [doc.objects.length] });
    return object;
  }

  // hidden and locked objects are out of reach of ordinary canvas taps,
  // drags, deletes and selection; the layers panel still reaches them
  function isSelectable(object) {
    return !object.hidden && !object.locked;
  }

  // every object under a screen point, topmost first
  function hitTestAll(sx, sy) {
    const point = screenToWorld(sx, sy);
    if (outsideAlpha <= 0.01) {
      const c = scene().canvas;
      if (Math.abs(point.x) > c.width / 2 || Math.abs(point.y) > c.height / 2) return [];
    }
    const minHalf = MIN_HIT_RADIUS / view.scale;
    const hits = [];
    for (let i = doc.objects.length - 1; i >= 0; i -= 1) {
      const object = doc.objects[i];
      if (!isSelectable(object)) continue; // hidden and locked layers ignore the canvas
      let dx = point.x - object.x;
      let dy = point.y - object.y;
      if (object.rotation) {
        const cos = Math.cos(-object.rotation);
        const sin = Math.sin(-object.rotation);
        const rx = dx * cos - dy * sin;
        dy = dx * sin + dy * cos;
        dx = rx;
      }
      const { hw, hh } = objectHalfSize(object);
      if (Math.abs(dx) <= Math.max(hw, minHalf) && Math.abs(dy) <= Math.max(hh, minHalf)) hits.push(object);
    }
    return hits;
  }

  function hitTest(sx, sy) {
    return hitTestAll(sx, sy)[0] || null;
  }

  function deleteObject(object) {
    const index = findObjectIndex(object.id);
    if (index === -1) return;
    commit({ type: 'delete-objects', objects: [object], indices: [index] });
  }

  // removes every emoji, inside and outside the canvas, as one undoable step
  // locked and hidden layers are kept
  function clearAllObjects() {
    const removable = doc.objects.filter(isSelectable);
    if (removable.length === 0) return;
    if (removable.length === doc.objects.length) {
      commit({ type: 'clear-objects', objects: doc.objects.slice() });
      return;
    }
    const indices = [];
    doc.objects.forEach((o, i) => { if (isSelectable(o)) indices.push(i); });
    commit({ type: 'delete-objects', label: 'delete all', objects: removable, indices });
  }

  function resizeCanvas(width, height) {
    const from = { width: doc.canvas.width, height: doc.canvas.height };
    if (from.width === width && from.height === height) return;
    commit({ type: 'resize-canvas', from, to: { width, height } });
  }

  function onDocumentChanged() {
    refreshClosedTimeline(true);
    updateHistoryButtons();
    updateClearButton();
    syncCanvasPanel();
    syncSelection();
    requestRender();
    scheduleSave();
  }


  /* 7b. selection and transforms
     ------------------------------------------------------------------------
     selection is the default canvas behavior whenever neither ➕ nor ➖ is
     active. a tap selects (nothing moves); repeated taps on the same spot
     cycle through overlapping emoji; a long press selects and starts
     editing. while editing, dragging moves the selection, the corner handle
     resizes it, the top handle rotates it, and two fingers do both.

     the selection frame is the outline in artwork coordinates. for one
     emoji it is that emoji's box; for several it is their shared box, which
     keeps its own rotation while you rotate them together.

     each completed drag, resize or rotation is one 'transform-objects' op.
     ======================================================================== */

  const selection = {
    ids: new Set(),
    editing: false,
    frame: null, // { cx, cy, w, h, angle } in artwork coordinates
  };
  let lastTap = null;
  let transform = null;
  let keepFrameOnSync = false;

  const unitKey = (o) => (o.groupId ? 'g:' + o.groupId : 'o:' + o.id);

  // an object together with the rest of its group
  function unitIds(object) {
    if (!object.groupId) return [object.id];
    return doc.objects.filter((o) => o.groupId === object.groupId && isSelectable(o)).map((o) => o.id);
  }

  function selectedObjects() {
    return doc.objects.filter((o) => selection.ids.has(o.id));
  }

  function objectCorners(o) {
    const { hw, hh } = objectHalfSize(o);
    const cos = Math.cos(o.rotation);
    const sin = Math.sin(o.rotation);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
      x: o.x + x * cos - y * sin,
      y: o.y + x * sin + y * cos,
    }));
  }

  function computeFrame() {
    const objects = selectedObjects();
    if (objects.length === 0) return null;
    if (objects.length === 1) {
      const o = objects[0];
      const { hw, hh } = objectHalfSize(o);
      return { cx: o.x, cy: o.y, w: hw * 2, h: hh * 2, angle: o.rotation };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    objects.forEach((o) => objectCorners(o).forEach((p) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }));
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, angle: 0 };
  }

  function setSelection(ids, options = {}) {
    selection.ids = new Set(ids);
    // every selection is fully editable (move, resize, rotate, menu); the
    // options argument is kept for older callers
    selection.editing = selection.ids.size > 0;
    selection.frame = computeFrame();
    closeObjectMenu();
    requestRender();
  }

  function clearSelection() {
    lastTap = null;
    if (selection.ids.size === 0 && !selection.editing) return;
    setSelection([]);
  }

  // shift-click and the two-finger gesture add or remove a whole unit
  function toggleUnit(object) {
    const ids = unitIds(object);
    const next = new Set(selection.ids);
    const all = ids.every((id) => next.has(id));
    ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
    lastTap = null;
    setSelection(next);
  }

  // after any change to the artwork (undo, redo, actions), drop selected
  // objects that no longer exist and refresh the outline
  function syncSelection() {
    if (selection.ids.size === 0) return;
    const existing = new Set(doc.objects.filter(isSelectable).map((o) => o.id));
    const kept = [...selection.ids].filter((id) => existing.has(id));
    if (kept.length !== selection.ids.size) {
      selection.ids = new Set(kept);
      if (kept.length === 0) selection.editing = false;
      keepFrameOnSync = false;
      closeObjectMenu();
    }
    if (!keepFrameOnSync || !selection.frame) selection.frame = computeFrame();
    keepFrameOnSync = false;
    if (menuOpen) updateObjectMenu();
  }

  // the outline as drawn on screen (never smaller than MIN_FRAME_SIZE)
  function frameOnScreen() {
    const f = selection.frame;
    if (!f) return null;
    const c = worldToScreen(f.cx, f.cy);
    return {
      cx: c.x,
      cy: c.y,
      w: Math.max(f.w * view.scale + SELECTION_PAD * 2, MIN_FRAME_SIZE),
      h: Math.max(f.h * view.scale + SELECTION_PAD * 2, MIN_FRAME_SIZE),
      angle: f.angle,
    };
  }

  function toFrameLocal(f, x, y) {
    const dx = x - f.cx;
    const dy = y - f.cy;
    const cos = Math.cos(-f.angle);
    const sin = Math.sin(-f.angle);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  function fromFrameLocal(f, x, y) {
    const cos = Math.cos(f.angle);
    const sin = Math.sin(f.angle);
    return { x: f.cx + x * cos - y * sin, y: f.cy + x * sin + y * cos };
  }

  function pointInFrame(x, y, extra = 0) {
    const f = frameOnScreen();
    if (!f) return false;
    const p = toFrameLocal(f, x, y);
    return Math.abs(p.x) <= f.w / 2 + extra && Math.abs(p.y) <= f.h / 2 + extra;
  }

  function handlePositions() {
    const f = frameOnScreen();
    if (!f) return null;
    return {
      frame: f,
      scale: fromFrameLocal(f, f.w / 2, f.h / 2),
      rotate: fromFrameLocal(f, 0, -f.h / 2 - ROTATE_HANDLE_OFFSET),
    };
  }

  function hitHandle(x, y) {
    if (!selection.editing || outlineStyle !== 'box') return null;
    const h = handlePositions();
    if (!h) return null;
    if (Math.hypot(x - h.rotate.x, y - h.rotate.y) <= HANDLE_RADIUS) return 'rotate';
    if (Math.hypot(x - h.scale.x, y - h.scale.y) <= HANDLE_RADIUS) return 'scale';
    return null;
  }

  // how the selection shows: on touch screens an outline that follows each
  // emoji's own shape (editing with fingers needs no handles); with a mouse
  // the box with resize and rotate handles. follows the last input used.
  const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  let outlineStyle = coarsePointer ? 'shape' : 'box';

  function noteInputType(pointerType) {
    const next = pointerType === 'mouse' ? 'box' : 'shape';
    if (next === outlineStyle) return;
    outlineStyle = next;
    requestRender();
  }

  // drawn on the stage after the artwork; never part of an export
  function drawSelection(ctx) {
    if (outlineStyle === 'shape') {
      drawShapeOutlines(ctx);
      return;
    }
    const h = handlePositions();
    if (!h) return;
    const f = h.frame;
    const accent = '0, 113, 227';
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = selection.editing ? `rgba(${accent}, 0.9)` : `rgba(${accent}, 0.55)`;
    if (!selection.editing) ctx.setLineDash([5, 4]);
    roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 8);
    ctx.stroke();
    ctx.setLineDash([]);

    if (selection.editing) {
      // rotation stem and handles
      ctx.beginPath();
      ctx.moveTo(0, -f.h / 2);
      ctx.lineTo(0, -f.h / 2 - ROTATE_HANDLE_OFFSET + HANDLE_DOT);
      ctx.stroke();
      [[0, -f.h / 2 - ROTATE_HANDLE_OFFSET], [f.w / 2, f.h / 2]].forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, HANDLE_DOT, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = 'rgba(15, 20, 25, 0.25)';
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.stroke();
      });
    }
    ctx.restore();
  }

  // shape outline: the emoji's silhouette, grown by a few pixels, minus the
  // silhouette itself, leaves a ring that hugs the glyph. built in device
  // pixels on a scratch canvas and cached while nothing changes.
  const OUTLINE_WIDTH = 3;          // css px
  const OUTLINE_MAX_PIXELS = 1400;  // device px; larger rings are drawn scaled
  const outlineCache = new Map();
  const outlineMask = document.createElement('canvas');

  function drawShapeOutlines(ctx) {
    // white while selected, blue only while it is being moved, resized or rotated
    const color = transform ? 'rgba(0, 113, 227, 1)' : '#FFFFFF';
    selectedObjects().forEach((object) => {
      const sx = object.x * view.scale + view.tx;
      const sy = object.y * view.scale + view.ty;
      const ring = outlineRing(object, object.size * view.scale, color);
      if (!ring) return;
      const w = ring.width / ring.ratio;
      const h = ring.height / ring.ratio;
      ctx.save();
      ctx.shadowColor = 'rgba(15, 20, 25, 0.35)';
      ctx.shadowBlur = 6;
      ctx.drawImage(ring, sx - w / 2, sy - h / 2, w, h);
      ctx.restore();
    });
  }

  function outlineRing(object, px, color) {
    if (px < 1) return null;
    const rotation = object.rotation || 0;
    const key = [object.emoji, px.toFixed(1), rotation.toFixed(3), color, pixelRatio].join('|');
    let ring = outlineCache.get(key);
    if (ring) {
      outlineCache.delete(key);
      outlineCache.set(key, ring); // most recently used last
      return ring;
    }

    const ink = getGlyphInk(object.emoji);
    // device pixels, capped for very large emoji
    let ratio = pixelRatio;
    const diagonal = Math.hypot(ink.w, ink.h) * px;
    if (diagonal * ratio > OUTLINE_MAX_PIXELS) ratio = OUTLINE_MAX_PIXELS / diagonal;
    const grow = OUTLINE_WIDTH * ratio;
    const size = Math.ceil(diagonal * ratio + grow * 2 + 8);

    // silhouette in the outline color
    outlineMask.width = size;
    outlineMask.height = size;
    const m = outlineMask.getContext('2d');
    m.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawEmoji(m, { emoji: object.emoji, rotation }, size / 2 / ratio, size / 2 / ratio, px);
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-in';
    m.fillStyle = color;
    m.fillRect(0, 0, size, size);

    // grow it in every direction, then cut the silhouette back out
    ring = document.createElement('canvas');
    ring.width = size;
    ring.height = size;
    ring.ratio = ratio;
    const r = ring.getContext('2d');
    const steps = 16;
    for (let i = 0; i < steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      r.drawImage(outlineMask, Math.cos(a) * grow, Math.sin(a) * grow);
    }
    r.globalCompositeOperation = 'destination-out';
    r.drawImage(outlineMask, 0, 0);

    outlineCache.set(key, ring);
    while (outlineCache.size > 24) outlineCache.delete(outlineCache.keys().next().value);
    return ring;
  }

  function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  // a transform gesture changes the live objects directly while it runs and
  // records a single op when it ends
  function beginTransform() {
    if (!selection.frame) return false;
    doc.objects = doc.objects.slice(); // never touch an array a snapshot may share
    const objects = selectedObjects();
    const start = new Map(objects.map((o) => [o.id, { x: o.x, y: o.y, size: o.size, rotation: o.rotation }]));
    transform = {
      origin: new Map(start), // for the history record
      start,                  // the base the current gesture works from
      frame0: { ...selection.frame },
      index: new Map(doc.objects.map((o, i) => [o.id, i])),
      changed: false,
    };
    closeObjectMenu();
    document.body.dataset.transforming = 'true';
    return true;
  }

  // continue the same recorded gesture from the current state (for example
  // when a second finger joins a one-finger drag)
  function rebaseTransform() {
    if (!transform) return;
    transform.start = new Map([...transform.start.keys()].map((id) => {
      const o = doc.objects[transform.index.get(id)];
      return [id, { x: o.x, y: o.y, size: o.size, rotation: o.rotation }];
    }));
    transform.frame0 = { ...selection.frame };
  }

  function applyTransform(dx, dy, scale, theta) {
    if (!transform) return;
    let lo = 0;
    let hi = Infinity;
    transform.start.forEach((t) => {
      lo = Math.max(lo, MIN_EMOJI_SIZE / t.size);
      hi = Math.min(hi, MAX_EMOJI_SIZE / t.size);
    });
    const s = Math.min(hi, Math.max(lo, scale));
    const f0 = transform.frame0;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    transform.start.forEach((t, id) => {
      const vx = t.x - f0.cx;
      const vy = t.y - f0.cy;
      const i = transform.index.get(id);
      doc.objects[i] = {
        ...doc.objects[i],
        x: f0.cx + (vx * cos - vy * sin) * s + dx,
        y: f0.cy + (vx * sin + vy * cos) * s + dy,
        size: t.size * s,
        rotation: t.rotation + theta,
      };
    });
    selection.frame = {
      cx: f0.cx + dx,
      cy: f0.cy + dy,
      w: f0.w * s,
      h: f0.h * s,
      angle: f0.angle + theta,
    };
    transform.changed = true;
    requestRender();
  }

  function endTransform() {
    if (!transform) return;
    const t = transform;
    transform = null;
    delete document.body.dataset.transforming;
    if (!t.changed) return;
    const changes = [];
    t.origin.forEach((from, id) => {
      const o = doc.objects[t.index.get(id)];
      const to = { x: o.x, y: o.y, size: o.size, rotation: o.rotation };
      if (from.x !== to.x || from.y !== to.y || from.size !== to.size || from.rotation !== to.rotation) {
        changes.push({ id, from, to });
      }
    });
    if (changes.length === 0) return;
    const kinds = [];
    if (changes.some((c) => c.from.x !== c.to.x || c.from.y !== c.to.y)) kinds.push('move');
    if (changes.some((c) => c.from.size !== c.to.size)) kinds.push('resize');
    if (changes.some((c) => c.from.rotation !== c.to.rotation)) kinds.push('rotate');
    keepFrameOnSync = true; // keep the shared outline's rotation
    commit({ type: 'transform-objects', label: kinds.join(' + '), changes });
  }


  /* 7c. object menu, grouping and stacking
     ------------------------------------------------------------------------
     while editing, tapping the selection opens a compact menu of actions
     for the selected emoji. only actions that would do something are shown.
     ======================================================================== */

  let menuOpen = false;

  function selectedUnitCount() {
    return new Set(selectedObjects().map(unitKey)).size;
  }

  // the new stacking order (ids, bottom to top) or null if nothing changes.
  // the selection moves as one block; another group counts as one step.
  function stackingOrder(action) {
    const objects = doc.objects;
    const ids = objects.map((o) => o.id);
    const selected = objects.filter((o) => selection.ids.has(o.id));
    if (selected.length === 0) return null;
    const rest = objects.filter((o) => !selection.ids.has(o.id));
    const indexOf = new Map(ids.map((id, i) => [id, i]));
    let order = null;

    if (action === 'front') order = rest.concat(selected);
    else if (action === 'back') order = selected.concat(rest);
    else if (action === 'forward') {
      const top = Math.max(...selected.map((o) => indexOf.get(o.id)));
      const above = objects.slice(top + 1).find((o) => !selection.ids.has(o.id));
      if (!above) return null;
      let limit = indexOf.get(above.id);
      if (above.groupId) {
        objects.forEach((o, i) => { if (o.groupId === above.groupId && !selection.ids.has(o.id)) limit = Math.max(limit, i); });
      }
      const pos = rest.filter((o) => indexOf.get(o.id) <= limit).length;
      order = rest.slice(0, pos).concat(selected, rest.slice(pos));
    } else if (action === 'backward') {
      const bottom = Math.min(...selected.map((o) => indexOf.get(o.id)));
      const below = objects.slice(0, bottom).reverse().find((o) => !selection.ids.has(o.id));
      if (!below) return null;
      let limit = indexOf.get(below.id);
      if (below.groupId) {
        objects.forEach((o, i) => { if (o.groupId === below.groupId && !selection.ids.has(o.id)) limit = Math.min(limit, i); });
      }
      const pos = rest.filter((o) => indexOf.get(o.id) < limit).length;
      order = rest.slice(0, pos).concat(selected, rest.slice(pos));
    }
    if (!order) return null;
    const next = order.map((o) => o.id);
    return next.every((id, i) => id === ids[i]) ? null : next;
  }

  function applyStacking(action) {
    const to = stackingOrder(action);
    if (!to) return;
    keepFrameOnSync = true;
    commit({ type: 'reorder', label: action, from: doc.objects.map((o) => o.id), to });
  }

  // copy and paste (desktop shortcuts). the clipboard is moji's own and
  // lives only in this page: it holds the copied emoji as they were when
  // copied. each paste adds a fresh copy (new ids, new groups) on top of the
  // stack, a step further from the original each time, and selects it.
  let clipboard = null;

  function copySelection() {
    const objects = selectedObjects();
    if (objects.length === 0 || !selection.frame) return false;
    const f = selection.frame;
    clipboard = {
      objects,
      offset: Math.min(160, Math.max(16, Math.min(f.w, f.h) * 0.18)),
      pastes: 0,
    };
    return true;
  }

  function pasteClipboard() {
    if (!clipboard || clipboard.objects.length === 0) return false;
    if (mode !== 'idle') setMode('idle');
    clipboard.pastes += 1;
    const shift = clipboard.offset * clipboard.pastes;
    const groupIds = new Map();
    const copies = clipboard.objects.map((o) => {
      const copy = { ...o, id: createId('obj'), x: o.x + shift, y: o.y + shift, order: nextOrder++, createdAt: Date.now() };
      if (o.groupId) {
        if (!groupIds.has(o.groupId)) groupIds.set(o.groupId, createId('group'));
        copy.groupId = groupIds.get(o.groupId);
      }
      return copy;
    });
    const start = doc.objects.length;
    commit({ type: 'add-objects', label: 'paste', objects: copies, indices: copies.map((c, k) => start + k) });
    setSelection(copies.map((c) => c.id));
    return true;
  }

  function duplicateSelection() {
    const objects = selectedObjects();
    if (objects.length === 0 || !selection.frame) return;
    const f = selection.frame;
    const offset = Math.min(160, Math.max(16, Math.min(f.w, f.h) * 0.18));
    const groupIds = new Map();
    const copies = objects.map((o) => {
      const copy = { ...o, id: createId('obj'), x: o.x + offset, y: o.y + offset, order: nextOrder++, createdAt: Date.now() };
      if (o.groupId) {
        if (!groupIds.has(o.groupId)) groupIds.set(o.groupId, createId('group'));
        copy.groupId = groupIds.get(o.groupId);
      }
      return copy;
    });
    // the copies sit directly above the topmost original, in the same order
    const top = Math.max(...objects.map((o) => findObjectIndex(o.id)));
    commit({ type: 'add-objects', label: 'duplicate', objects: copies, indices: copies.map((c, k) => top + 1 + k) });
    setSelection(copies.map((c) => c.id), { editing: true });
  }

  // grouping also gathers the members into one block in the stacking order,
  // where the topmost of them was, so the group is one folder in the layers
  // panel. the members keep their order among themselves.
  function groupSelection() {
    if (selectedUnitCount() < 2) return;
    const groupId = createId('group');
    const ids = doc.objects.map((o) => o.id);
    const top = Math.max(...ids.map((id, i) => (selection.ids.has(id) ? i : -1)));
    const members = ids.filter((id) => selection.ids.has(id));
    const order = [];
    ids.forEach((id, i) => {
      if (!selection.ids.has(id)) order.push(id);
      if (i === top) order.push(...members);
    });
    const groupOf = new Map(doc.objects.map((o) => [o.id, o.groupId || null]));
    members.forEach((id) => groupOf.set(id, groupId));
    keepFrameOnSync = true;
    commitArrangement(order, groupOf, 'group');
  }

  // one 'arrange' step from a new order (bottom to top) and group map.
  // a group left with a single member dissolves in the same step.
  function arrangementOp(order, groupOf, label) {
    const counts = new Map();
    groupOf.forEach((g) => { if (g) counts.set(g, (counts.get(g) || 0) + 1); });
    const from = doc.objects.map((o) => o.id);
    const groups = [];
    doc.objects.forEach((o) => {
      let to = groupOf.get(o.id) || null;
      if (to && counts.get(to) < 2) to = null;
      const before = o.groupId || null;
      if (to !== before) groups.push({ id: o.id, from: before, to });
    });
    const same = groups.length === 0 && from.every((id, i) => id === order[i]);
    return same ? null : { type: 'arrange', label, from, to: order.slice(), groups };
  }

  function commitArrangement(order, groupOf, label) {
    const op = arrangementOp(order, groupOf, label);
    if (op) commit(op);
    return Boolean(op);
  }

  function ungroupSelection() {
    const changes = selectedObjects().filter((o) => o.groupId).map((o) => ({ id: o.id, from: o.groupId, to: null }));
    if (changes.length === 0) return;
    keepFrameOnSync = true;
    commit({ type: 'set-groups', label: 'ungroup', changes });
  }

  function updateObjectMenu() {
    const show = {
      duplicate: selection.ids.size > 0,
      group: selectedUnitCount() >= 2,
      ungroup: selectedObjects().some((o) => o.groupId),
      front: Boolean(stackingOrder('front')),
      forward: Boolean(stackingOrder('forward')),
      backward: Boolean(stackingOrder('backward')),
      back: Boolean(stackingOrder('back')),
    };
    dom.menuButtons.forEach((button) => { button.hidden = !show[button.dataset.menu]; });
    dom.menuRows.forEach((row) => { row.hidden = ![...row.children].some((b) => !b.hidden); });
  }

  function openObjectMenu() {
    if (!selection.editing || selection.ids.size === 0) return;
    updateObjectMenu();
    menuOpen = true;
    showAnimated(dom.objectMenu);
    positionObjectMenu();
  }

  function closeObjectMenu() {
    if (!menuOpen) return false;
    menuOpen = false;
    hideAnimated(dom.objectMenu);
    return true;
  }

  // above the selection when there is room, otherwise below; inside the viewport
  function positionObjectMenu() {
    const f = frameOnScreen();
    if (!f) return;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => fromFrameLocal(f, sx * f.w / 2, sy * f.h / 2));
    const top = Math.min(...corners.map((p) => p.y)) - (selection.editing ? ROTATE_HANDLE_OFFSET + HANDLE_DOT : 0);
    const bottom = Math.max(...corners.map((p) => p.y));
    const menuWidth = dom.objectMenu.offsetWidth;
    const menuHeight = dom.objectMenu.offsetHeight;
    const margin = 8;
    const gap = 10;
    const topLimit = dom.toolsBar.getBoundingClientRect().bottom + margin;
    let y = top - gap - menuHeight;
    if (y < topLimit) y = bottom + gap + HANDLE_DOT;
    y = Math.min(Math.max(y, margin), viewportHeight - menuHeight - margin);
    const x = Math.min(Math.max(f.cx - menuWidth / 2, margin), viewportWidth - menuWidth - margin);
    dom.objectMenu.style.left = Math.round(x) + 'px';
    dom.objectMenu.style.top = Math.round(y) + 'px';
  }

  function onObjectMenuClick(event) {
    const button = event.target.closest('[data-menu]');
    if (!button) return;
    showCaption(button.dataset.name, button);
    const action = button.dataset.menu;
    closeObjectMenu();
    if (action === 'duplicate') duplicateSelection();
    else if (action === 'group') groupSelection();
    else if (action === 'ungroup') ungroupSelection();
    else applyStacking(action);
  }


  /* 7d. layers panel
     ------------------------------------------------------------------------
     🗂️ opens a floating list of every emoji and group in stacking order,
     frontmost first. it stays open beside the canvas until closed, follows
     the canvas selection both ways, and shows the previewed moment (read
     only) while the timeline is open.

     groups are folders: collapsed, the row selects and toggles the whole
     group; expanded, each member is its own row that can be selected,
     hidden or locked without ungrouping. expanding is an interface
     preference only, never a history step.

     drag a row's grip to restack it, or to move an emoji into, out of, or
     between groups. the canvas follows live; the whole drag is one 'arrange'
     step when it ends, and nothing at all if it is cancelled.
     ======================================================================== */

  const layers = {
    open: false,
    expanded: new Set(),   // group ids shown open
    drag: null,
    shownObjects: null,    // what the list was last built from
    shownKey: '',
  };
  const LAYER_EDGE_SCROLL = 36;  // px from the list's edge where dragging scrolls
  const LAYER_SCROLL_SPEED = 9;  // px per frame at the very edge

  const emojiNames = new Map();
  function emojiName(emoji) {
    if (emojiNames.size === 0) {
      EMOJI_CATEGORIES.forEach((category) => category.items.forEach(([e, name]) => {
        emojiNames.set(e, name);
        emojiNames.set(e.replace(/\uFE0F/g, ''), name);
      }));
    }
    return emojiNames.get(emoji) || emojiNames.get(emoji.replace(/\uFE0F/g, '')) || 'emoji';
  }

  const ICONS = {
    eye: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    eyeOff: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><line x1="4" y1="20" x2="20" y2="4"/></svg>',
    lock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
    unlock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2"/></svg>',
    grip: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="6" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="16" x2="18" y2="16"/></svg>',
    chevron: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="10 7 15 12 10 17"/></svg>',
  };

  // the list's structure, frontmost first: emoji and groups (with members,
  // frontmost first). a group sits where its topmost member is.
  function layerEntries(objects) {
    const entries = [];
    const seen = new Set();
    for (let i = objects.length - 1; i >= 0; i -= 1) {
      const o = objects[i];
      if (!o.groupId) {
        entries.push({ type: 'object', id: o.id, object: o });
      } else if (!seen.has(o.groupId)) {
        seen.add(o.groupId);
        const members = [];
        for (let j = i; j >= 0; j -= 1) if (objects[j].groupId === o.groupId) members.push(objects[j]);
        entries.push({ type: 'group', id: o.groupId, members });
      }
    }
    return entries;
  }

  function layersReadOnly() {
    return timeline.open;
  }

  function toggleLayersPanel() {
    if (layers.open) closeLayersPanel();
    else openLayersPanel();
  }

  function openLayersPanel() {
    layers.open = true;
    dom.layersTool.setAttribute('aria-pressed', 'true');
    layers.shownKey = '';
    renderLayers();
    showAnimated(dom.layers);
    positionLayersPanel();
  }

  function closeLayersPanel() {
    if (!layers.open) return false;
    cancelLayerDrag();
    layers.open = false;
    dom.layersTool.setAttribute('aria-pressed', 'false');
    hideAnimated(dom.layers);
    return true;
  }

  // under the tools (and their drop-down tab), above the timeline
  function positionLayersPanel() {
    if (!layers.open) return;
    const margin = 8;
    let top = dom.toolsBar.getBoundingClientRect().bottom;
    if (!dom.toolsDrop.hidden) top = Math.max(top, dom.toolsDrop.getBoundingClientRect().bottom);
    top += margin;
    const bottom = dom.timelineBar.getBoundingClientRect().top - margin;
    let height = Math.max(120, bottom - top);
    if (isPhoneLayout()) height = Math.min(height, Math.round(viewportHeight * 0.42));
    const style = dom.layers.style;
    const nextTop = Math.round(top) + 'px';
    const nextMax = Math.round(height) + 'px';
    if (style.top !== nextTop) style.top = nextTop;
    if (style.maxHeight !== nextMax) style.maxHeight = nextMax;
  }

  // rebuilds the list when the artwork, selection or folders change (never
  // during a layer drag, whose list stays still under the finger)
  function renderLayers() {
    if (!layers.open || layers.drag) return;
    const shown = scene();
    const readOnly = layersReadOnly();
    const key = [readOnly, [...selection.ids].join(','), [...layers.expanded].join(',')].join('|');
    if (shown.objects === layers.shownObjects && key === layers.shownKey) return;
    layers.shownObjects = shown.objects;
    layers.shownKey = key;
    dom.layers.dataset.readonly = String(readOnly);

    const entries = layerEntries(shown.objects);
    // forget folders that no longer exist
    const groupIds = new Set(entries.filter((e) => e.type === 'group').map((e) => e.id));
    layers.expanded.forEach((id) => { if (!groupIds.has(id)) layers.expanded.delete(id); });

    const count = shown.objects.length;
    dom.layersCount.textContent = String(count);
    const list = dom.layersList;
    const scrollTop = dom.layersScroll.scrollTop;
    list.textContent = '';
    if (count === 0) {
      const empty = document.createElement('li');
      empty.className = 'layers__empty';
      empty.textContent = 'nothing placed yet';
      list.appendChild(empty);
      return;
    }
    const selected = readOnly ? new Set() : selection.ids;
    entries.forEach((entry) => {
      if (entry.type === 'object') {
        list.appendChild(layerRow(entry.object, 0, null, selected));
        return;
      }
      const expanded = layers.expanded.has(entry.id);
      list.appendChild(groupRow(entry, expanded, selected));
      if (expanded) entry.members.forEach((o) => list.appendChild(layerRow(o, 1, entry.id, selected)));
    });
    dom.layersScroll.scrollTop = scrollTop;
  }

  function layerRow(o, depth, groupId, selected) {
    const row = document.createElement('li');
    row.className = 'layer-row';
    row.dataset.kind = groupId ? 'child' : 'object';
    row.dataset.id = o.id;
    if (groupId) row.dataset.group = groupId;
    row.style.setProperty('--depth', depth);
    row.dataset.hidden = String(Boolean(o.hidden));
    row.setAttribute('aria-selected', String(selected.has(o.id)));
    const spacer = document.createElement('span');
    spacer.className = 'layer-row__spacer';
    const thumb = document.createElement('span');
    thumb.className = 'layer-row__thumb';
    thumb.setAttribute('aria-hidden', 'true');
    thumb.textContent = o.emoji;
    const name = document.createElement('span');
    name.className = 'layer-row__name';
    name.textContent = emojiName(o.emoji);
    row.append(spacer, thumb, name, ...layerControls(Boolean(o.hidden), Boolean(o.locked), name.textContent));
    return row;
  }

  function groupRow(entry, expanded, selected) {
    const row = document.createElement('li');
    row.className = 'layer-row';
    row.dataset.kind = 'group';
    row.dataset.id = entry.id;
    row.dataset.group = entry.id;
    row.setAttribute('aria-expanded', String(expanded));
    const hidden = entry.members.every((o) => o.hidden);
    const locked = entry.members.every((o) => o.locked);
    row.dataset.hidden = String(hidden);
    const reachable = entry.members.filter(isSelectable);
    row.setAttribute('aria-selected', String(reachable.length > 0 && reachable.every((o) => selected.has(o.id))));
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'layer-row__expand';
    expand.dataset.layerAction = 'expand';
    expand.setAttribute('aria-label', expanded ? 'collapse group' : 'expand group');
    expand.innerHTML = ICONS.chevron;
    const thumb = document.createElement('span');
    thumb.className = 'layer-row__thumb layer-row__thumb--group';
    thumb.setAttribute('aria-hidden', 'true');
    entry.members.slice(0, 3).reverse().forEach((o) => {
      const e = document.createElement('span');
      e.textContent = o.emoji;
      thumb.appendChild(e);
    });
    const name = document.createElement('span');
    name.className = 'layer-row__name';
    name.textContent = `group · ${entry.members.length}`;
    row.append(expand, thumb, name, ...layerControls(hidden, locked, 'group'));
    return row;
  }

  function layerControls(hidden, locked, label) {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'layer-row__toggle';
    eye.dataset.layerAction = 'visibility';
    eye.dataset.name = hidden ? 'show' : 'hide';
    eye.setAttribute('aria-pressed', String(hidden));
    eye.setAttribute('aria-label', `hide ${label}`);
    eye.innerHTML = hidden ? ICONS.eyeOff : ICONS.eye;
    const lock = document.createElement('button');
    lock.type = 'button';
    lock.className = 'layer-row__toggle';
    lock.dataset.layerAction = 'lock';
    lock.dataset.name = locked ? 'unlock' : 'lock';
    lock.setAttribute('aria-pressed', String(locked));
    lock.setAttribute('aria-label', `lock ${label}`);
    lock.innerHTML = locked ? ICONS.lock : ICONS.unlock;
    const grip = document.createElement('span');
    grip.className = 'layer-row__grip';
    grip.dataset.layerAction = 'drag';
    grip.setAttribute('aria-hidden', 'true');
    grip.innerHTML = ICONS.grip;
    return [eye, lock, grip];
  }

  // the objects a row stands for
  function rowObjects(row) {
    if (row.dataset.kind === 'group') return doc.objects.filter((o) => o.groupId === row.dataset.id);
    const o = doc.objects.find((x) => x.id === row.dataset.id);
    return o ? [o] : [];
  }

  function onLayersClick(event) {
    const row = event.target.closest('.layer-row');
    if (!row) return;
    const control = event.target.closest('[data-layer-action]');
    const action = control ? control.dataset.layerAction : 'select';
    if (action === 'drag') return;
    if (action === 'expand') {
      // an interface preference: no history step
      const id = row.dataset.id;
      if (layers.expanded.has(id)) layers.expanded.delete(id);
      else layers.expanded.add(id);
      renderLayers();
      return;
    }
    if (layersReadOnly()) return;
    const objects = rowObjects(row);
    if (objects.length === 0) return;

    if (action === 'visibility' || action === 'lock') {
      const key = action === 'visibility' ? 'hidden' : 'locked';
      const on = !objects.every((o) => o[key]); // a mixed group turns fully on
      const changes = objects.filter((o) => Boolean(o[key]) !== on).map((o) => {
        const from = { hidden: Boolean(o.hidden), locked: Boolean(o.locked) };
        return { id: o.id, from, to: { ...from, [key]: on } };
      });
      if (changes.length) {
        const label = key === 'hidden' ? (on ? 'hide' : 'show') : (on ? 'lock' : 'unlock');
        commit({ type: 'set-flags', label, changes });
      }
      showCaption(control.dataset.name, control);
      return;
    }

    // select: hidden and locked layers stay out of the canvas selection
    const reachable = objects.filter(isSelectable).map((o) => o.id);
    if (reachable.length === 0) {
      showCaption(objects.every((o) => o.hidden) ? 'hidden' : 'locked', row.querySelector('.layer-row__name'));
      return;
    }
    lastTap = null;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      const next = new Set(selection.ids);
      const all = reachable.every((id) => next.has(id));
      reachable.forEach((id) => (all ? next.delete(id) : next.add(id)));
      setSelection(next);
    } else {
      setSelection(reachable);
    }
  }

  // ----- dragging rows -----

  function onLayerGripDown(event) {
    const grip = event.target.closest('.layer-row__grip');
    if (!grip || layers.drag || layersReadOnly()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const row = grip.closest('.layer-row');
    try { grip.setPointerCapture(event.pointerId); } catch (e) { /* synthetic */ }
    const kind = row.dataset.kind === 'group' ? 'group' : 'object';
    layers.drag = {
      pointerId: event.pointerId,
      grip,
      kind,
      id: row.dataset.id,
      fromGroup: kind === 'object' ? (row.dataset.group || null) : null,
      original: doc.objects,
      y: event.clientY,
      target: null,
      frame: null,
    };
    // the dragged row (and a group's members) step back while it moves
    dom.layersList.querySelectorAll('.layer-row').forEach((r) => {
      if (r.dataset.id === layers.drag.id || (kind === 'group' && r.dataset.group === layers.drag.id)) {
        r.classList.add('is-dragging');
      }
    });
    document.body.dataset.layerDrag = 'true';
    closeObjectMenu();
    updateLayerDrag();
    layers.drag.frame = requestAnimationFrame(layerDragFrame);
  }

  function onLayerGripMove(event) {
    const drag = layers.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    updateLayerDrag();
  }

  function onLayerGripUp(event) {
    const drag = layers.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.type === 'pointercancel') {
      cancelLayerDrag();
      return;
    }
    const result = drag.target ? arrangementFor(drag, drag.target) : null;
    endLayerDrag();
    if (result) {
      keepFrameOnSync = false;
      commitArrangement(result.order, result.groupOf, result.label);
    }
  }

  // put everything back as it was, with no history step
  function cancelLayerDrag() {
    if (!layers.drag) return;
    endLayerDrag();
    requestRender();
  }

  function endLayerDrag() {
    const drag = layers.drag;
    cancelAnimationFrame(drag.frame);
    doc.objects = drag.original;
    layers.drag = null;
    delete document.body.dataset.layerDrag;
    dom.layersIndicator.hidden = true;
    layers.shownKey = '';
    renderLayers();
    syncSelection();
  }

  // scrolls the list while the finger rests near its top or bottom edge
  function layerDragFrame() {
    const drag = layers.drag;
    if (!drag) return;
    const box = dom.layersScroll.getBoundingClientRect();
    let delta = 0;
    if (drag.y < box.top + LAYER_EDGE_SCROLL) delta = -LAYER_SCROLL_SPEED * Math.min(1, (box.top + LAYER_EDGE_SCROLL - drag.y) / LAYER_EDGE_SCROLL);
    else if (drag.y > box.bottom - LAYER_EDGE_SCROLL) delta = LAYER_SCROLL_SPEED * Math.min(1, (drag.y - box.bottom + LAYER_EDGE_SCROLL) / LAYER_EDGE_SCROLL);
    if (delta) {
      const before = dom.layersScroll.scrollTop;
      dom.layersScroll.scrollTop += delta;
      if (dom.layersScroll.scrollTop !== before) updateLayerDrag();
    }
    drag.frame = requestAnimationFrame(layerDragFrame);
  }

  // where the pointer would drop: { parent: groupId|null, refId, where } with
  // where = 'before' | 'after' | 'inside' (inside = top of that group)
  function layerDropTarget(drag) {
    const rows = [...dom.layersList.querySelectorAll('.layer-row')].filter((r) => !r.classList.contains('is-dragging'));
    if (rows.length === 0) return null;
    const y = drag.y;
    const first = rows[0].getBoundingClientRect();
    if (y < first.top) return topLevelTarget(rows[0], 'before');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const r = row.getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      const f = (y - r.top) / r.height;
      const kind = row.dataset.kind;
      if (kind === 'group') {
        const expanded = row.getAttribute('aria-expanded') === 'true';
        if (f < 0.25) return { parent: null, refId: row.dataset.id, where: 'before', row };
        if (drag.kind === 'object' && (f < 0.75 || expanded)) return { parent: row.dataset.id, refId: null, where: 'inside', row };
        if (drag.kind === 'group' && expanded && f >= 0.5) return { parent: null, refId: row.dataset.id, where: 'after', row: lastRowOf(rows, row.dataset.id) || row };
        return { parent: null, refId: row.dataset.id, where: f < 0.5 ? 'before' : 'after', row };
      }
      if (kind === 'child') {
        if (drag.kind === 'group') return topLevelTarget(row, f < 0.5 ? 'before' : 'after', rows);
        const next = rows[i + 1];
        const isLast = !next || next.dataset.group !== row.dataset.group || next.dataset.kind === 'group';
        if (isLast && f > 0.7) return { parent: null, refId: row.dataset.group, where: 'after', row };
        return { parent: row.dataset.group, refId: row.dataset.id, where: f < 0.5 ? 'before' : 'after', row };
      }
      return { parent: null, refId: row.dataset.id, where: f < 0.5 ? 'before' : 'after', row };
    }
    // in a gap or below everything: after the last row's top-level entry
    let lastBefore = null;
    rows.forEach((row) => { if (row.getBoundingClientRect().bottom <= y) lastBefore = row; });
    return topLevelTarget(lastBefore || rows[rows.length - 1], 'after', rows);
  }

  function lastRowOf(rows, groupId) {
    let last = null;
    rows.forEach((r) => { if (r.dataset.group === groupId) last = r; });
    return last;
  }

  // a target beside the top-level entry a row belongs to
  function topLevelTarget(row, where, rows) {
    if (row.dataset.kind === 'child') {
      const groupId = row.dataset.group;
      const anchor = where === 'after' && rows ? lastRowOf(rows, groupId) : row;
      return { parent: null, refId: groupId, where, row: anchor || row };
    }
    if (row.dataset.kind === 'group' && where === 'after' && rows) {
      return { parent: null, refId: row.dataset.id, where, row: lastRowOf(rows, row.dataset.id) || row };
    }
    return { parent: null, refId: row.dataset.id, where, row };
  }

  // the stacking order (bottom to top) and group map a drop would produce
  function arrangementFor(drag, target) {
    const entries = layerEntries(drag.original).map((e) => (e.type === 'group'
      ? { type: 'group', id: e.id, members: e.members.map((o) => o.id) }
      : { type: 'object', id: e.id }));
    let moving;
    if (drag.kind === 'group') {
      const i = entries.findIndex((e) => e.type === 'group' && e.id === drag.id);
      if (i === -1) return null;
      moving = entries.splice(i, 1)[0];
      if (target.parent) return null; // groups never go inside groups
    } else {
      moving = { type: 'object', id: drag.id };
      const top = entries.findIndex((e) => e.type === 'object' && e.id === drag.id);
      if (top !== -1) entries.splice(top, 1);
      else entries.forEach((e) => { if (e.type === 'group') e.members = e.members.filter((id) => id !== drag.id); });
    }

    let toGroup = null;
    if (target.parent) {
      const group = entries.find((e) => e.type === 'group' && e.id === target.parent);
      if (!group) return null;
      toGroup = group.id;
      if (target.where === 'inside') group.members.unshift(moving.id);
      else {
        let k = group.members.indexOf(target.refId);
        if (k === -1) k = 0;
        group.members.splice(target.where === 'after' ? k + 1 : k, 0, moving.id);
      }
    } else {
      let k = entries.findIndex((e) => e.id === target.refId);
      if (k === -1) k = target.where === 'after' ? entries.length - 1 : 0;
      entries.splice(target.where === 'after' ? k + 1 : k, 0, moving);
    }

    const topDown = [];
    const groupOf = new Map();
    entries.forEach((e) => {
      if (e.type === 'group') {
        e.members.forEach((id) => { topDown.push(id); groupOf.set(id, e.id); });
      } else {
        topDown.push(e.id);
        groupOf.set(e.id, null);
      }
    });
    let label = 'reorder';
    if (drag.kind === 'object' && toGroup !== drag.fromGroup) {
      label = !drag.fromGroup ? 'into group' : !toGroup ? 'out of group' : 'between groups';
    }
    return { order: topDown.reverse(), groupOf, label };
  }

  // the live preview: the canvas shows the arrangement under the finger
  function updateLayerDrag() {
    const drag = layers.drag;
    const target = layerDropTarget(drag);
    drag.target = target;
    dom.layersList.querySelectorAll('.is-drop-target').forEach((r) => r.classList.remove('is-drop-target'));
    const indicator = dom.layersIndicator;
    if (!target) {
      indicator.hidden = true;
      doc.objects = drag.original;
      requestRender();
      return;
    }
    if (target.where === 'inside') {
      indicator.hidden = true;
      target.row.classList.add('is-drop-target');
    } else {
      const row = target.row;
      const depth = target.parent ? 1 : 0;
      indicator.hidden = false;
      indicator.style.top = (row.offsetTop + (target.where === 'after' ? row.offsetHeight : 0)) + 'px';
      indicator.style.left = (14 + depth * 18) + 'px';
    }
    // the op is measured against the original order, then previewed
    doc.objects = drag.original;
    const result = arrangementFor(drag, target);
    const op = result && arrangementOp(result.order, result.groupOf, result.label);
    if (op) {
      const preview = { canvas: doc.canvas, objects: drag.original, undo: [], redo: [] };
      H.operations.arrange.apply(preview, op);
      doc.objects = preview.objects;
    }
    requestRender();
  }


  /* 8. modes
     ------------------------------------------------------------------------
     idle: taps select (see 7b). place: each tap places the current
     material. delete: each tap removes the topmost emoji under the pointer.
     ======================================================================== */

  let mode = 'idle';
  let material = null;
  let lastMaterial = null; // ➕ remembers the last emoji chosen (this session)

  // 🧹 is dimmed when there is nothing to delete
  function updateClearButton() {
    if (mode === 'delete') {
      dom.dropButton.setAttribute('aria-disabled', String(!doc.objects.some(isSelectable)));
    }
  }

  // ➕ and ➖ toggle their modes; the active one grows a drop-down tab
  function setMode(next) {
    const previous = mode;
    if (next !== 'idle') clearSelection();
    mode = next;
    document.body.dataset.mode = next;
    dom.addTool.setAttribute('aria-pressed', String(next === 'place'));
    dom.deleteTool.setAttribute('aria-pressed', String(next === 'delete'));
    if (next !== 'place') material = null;
    updateDrop(previous !== next);
  }

  function selectMaterial(emoji) {
    closePanel();
    setToolsExpanded(true);
    const wasPlacing = mode === 'place';
    mode = 'place';
    material = emoji;
    lastMaterial = emoji;
    if (wasPlacing) updateDrop(false);
    else setMode('place');
  }


  /* 8b. tools shape and drop-down
     ------------------------------------------------------------------------
     the tools panel and its drop-down tab are one continuous glass outline.
     its width, the tab's depth and the tab's position are springs; each
     frame one svg path is rebuilt from them and used as the glass clip, the
     shadow and the edge, so the panel genuinely morphs: it stretches, and the
     tab grows out of its bottom edge with smooth inward curves where they
     meet (or merges into the rounded end when it sits at the very edge).

     while placing, the tab hangs under ➕ showing the current emoji (tap to
     change it). while deleting, it hangs under ➖ with 🧹 (delete all).
     ======================================================================== */

  const TAB_WIDTH = 52;        // px, the tab around a 44px tool
  const TAB_DEPTH = 54;        // px the tab grows below the panel
  const TAB_FILLET = 10;       // px, inward curve where the tab meets the panel
  const SPRING_STIFFNESS = 420;
  const SPRING_DAMPING = 36;   // a touch under critical: settles with a tiny overshoot

  const shape = {
    width: { value: 0, velocity: 0, target: 0 },
    depth: { value: 0, velocity: 0, target: 0 },
    center: { value: 0, velocity: 0, target: 0 }, // tab center, px from the right edge
  };
  let shapeFrame = null;
  let shapeLastTime = 0;

  function collapsedToolsWidth() {
    return dom.toolsAnchor.offsetWidth;
  }

  function expandedToolsWidth() {
    return dom.toolsAnchor.offsetWidth + dom.toolsRow.offsetWidth;
  }

  // distance from the panel's right edge to the center of a tool
  function toolCenterFromRight(tool) {
    const rowWidth = dom.toolsRow.offsetWidth;
    const toolRight = rowWidth - (tool.offsetLeft + tool.offsetWidth);
    return dom.toolsAnchor.offsetWidth + toolRight + tool.offsetWidth / 2;
  }

  function capsulePath(w, h) {
    const r = h / 2;
    return `M ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w} ${r} A ${r} ${r} 0 0 1 ${w - r} ${h} ` +
      `L ${r} ${h} A ${r} ${r} 0 0 1 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  }

  // the panel outline with a tab of depth d centered at x = cx
  function toolsShapePath(w, h, d, cx) {
    if (d < 0.5) return capsulePath(w, h);
    const r = h / 2;
    const half = TAB_WIDTH / 2;
    const fillet = Math.min(TAB_FILLET, d / 2);
    const corner = Math.max(0, Math.min(half, d - fillet));
    const left = Math.max(0, cx - half);
    const right = Math.min(w, cx + half);
    const bottom = h + d;
    const n = (v) => Math.round(v * 100) / 100;

    const parts = [
      `M ${n(r)} 0`, `L ${n(w - r)} 0`,
      `A ${n(r)} ${n(r)} 0 0 1 ${n(w)} ${n(r)}`,
      `A ${n(r)} ${n(r)} 0 0 1 ${n(w - r)} ${n(h)}`,
    ];

    // right side of the tab (tabs sit under ➕/➖, well away from the right end)
    if (right + fillet <= w - r) {
      parts.push(`L ${n(right + fillet)} ${n(h)}`, `A ${n(fillet)} ${n(fillet)} 0 0 0 ${n(right)} ${n(h + fillet)}`);
    } else {
      parts.push(`L ${n(right)} ${n(h)}`);
    }

    // tab sides and rounded bottom
    parts.push(
      `L ${n(right)} ${n(bottom - corner)}`,
      `A ${n(corner)} ${n(corner)} 0 0 1 ${n(right - corner)} ${n(bottom)}`,
      `L ${n(left + corner)} ${n(bottom)}`,
      `A ${n(corner)} ${n(corner)} 0 0 1 ${n(left)} ${n(bottom - corner)}`,
    );

    // left side: an inward curve back to the bottom edge, or, when the tab
    // sits at the panel's rounded end, a straight rise into that curve
    if (left - fillet >= r) {
      parts.push(
        `L ${n(left)} ${n(h + fillet)}`,
        `A ${n(fillet)} ${n(fillet)} 0 0 0 ${n(left - fillet)} ${n(h)}`,
        `L ${n(r)} ${n(h)}`,
        `A ${n(r)} ${n(r)} 0 0 1 0 ${n(r)}`,
      );
    } else if (left >= r) {
      parts.push(`L ${n(left)} ${n(h)}`, `L ${n(r)} ${n(h)}`, `A ${n(r)} ${n(r)} 0 0 1 0 ${n(r)}`);
    } else {
      const dx = r - left;
      const joinY = r + Math.sqrt(Math.max(0, r * r - dx * dx));
      parts.push(`L ${n(left)} ${n(joinY)}`);
      if (left > 0.01) parts.push(`A ${n(r)} ${n(r)} 0 0 1 0 ${n(r)}`);
    }
    parts.push(`A ${n(r)} ${n(r)} 0 0 1 ${n(r)} 0`, 'Z');
    return parts.join(' ');
  }

  function drawToolsShape() {
    const w = shape.width.value;
    const h = dom.tools.offsetHeight;
    const d = Math.max(0, shape.depth.value);
    const path = toolsShapePath(w, h, d, w - shape.center.value);
    dom.tools.style.width = w + 'px';
    dom.toolsShape.style.width = w + 'px';
    dom.toolsShapeGlass.style.clipPath = `path('${path}')`;
    dom.toolsShapeGlass.style.webkitClipPath = `path('${path}')`;
    dom.toolsShapePaths.forEach((el) => el.setAttribute('d', path));
    // the tab's button rides along with the tab
    dom.toolsDrop.style.setProperty('--drop-right', (shape.center.value - TAB_WIDTH / 2) + 'px');
  }

  // set where the shape should go; the springs take it there
  function setShapeTarget(target) {
    if (target.width !== undefined) shape.width.target = target.width;
    if (target.depth !== undefined) shape.depth.target = target.depth;
    if (target.center !== undefined) {
      shape.center.target = target.center;
      // a tab that is not out yet starts right under its tool
      if (shape.depth.value < 1) {
        shape.center.value = target.center;
        shape.center.velocity = 0;
      }
    }

    if (reducedMotion.matches) {
      Object.values(shape).forEach((s) => { s.value = s.target; s.velocity = 0; });
      drawToolsShape();
      return;
    }
    if (!shapeFrame) {
      shapeLastTime = performance.now();
      shapeFrame = requestAnimationFrame(stepToolsShape);
    }
  }

  function stepToolsShape(now) {
    let dt = Math.min(0.12, (now - shapeLastTime) / 1000); // slow frames still finish on time
    shapeLastTime = now;

    // sequence the morph: the tab folds up before the panel narrows, and the
    // panel widens before the tab grows, so the tab never hangs off an edge
    const widthGoal = shape.depth.value > 2 && shape.width.target < shape.width.value
      ? shape.width.value : shape.width.target;
    const depthGoal = shape.depth.target > 0 && shape.width.value < shape.width.target - 6
      ? 0 : shape.depth.target;
    const goals = { width: widthGoal, depth: depthGoal, center: shape.center.target };

    // fixed small steps keep the spring stable on slow frames
    while (dt > 0) {
      const step = Math.min(dt, 1 / 240);
      dt -= step;
      Object.keys(shape).forEach((key) => {
        const s = shape[key];
        const force = -SPRING_STIFFNESS * (s.value - goals[key]) - SPRING_DAMPING * s.velocity;
        s.velocity += force * step;
        s.value += s.velocity * step;
      });
    }

    const settled = Object.keys(shape).every((key) => {
      const s = shape[key];
      return s.target === goals[key] && Math.abs(s.value - s.target) < 0.2 && Math.abs(s.velocity) < 2;
    });
    if (settled) {
      Object.values(shape).forEach((s) => { s.value = s.target; s.velocity = 0; });
    }

    drawToolsShape();
    requestRender(); // the canvas label checks whether the tab covers it
    shapeFrame = settled ? null : requestAnimationFrame(stepToolsShape);
  }

  function updateDrop() {
    const drop = dom.toolsDrop;
    const button = dom.dropButton;
    if (mode === 'idle') {
      if (!drop.hidden) hideAnimated(drop);
      setShapeTarget({ depth: 0 });
      requestRender();
      return;
    }

    const icon = button.querySelector('.emoji-icon');
    if (mode === 'place') {
      icon.textContent = material || '';
      button.dataset.name = 'change emoji';
      button.setAttribute('aria-label', 'change emoji');
      button.removeAttribute('aria-disabled');
    } else {
      icon.textContent = '🧹';
      button.dataset.name = 'delete all';
      button.setAttribute('aria-label', 'delete all emoji');
      updateClearButton();
    }

    const tool = mode === 'place' ? dom.addTool : dom.deleteTool;
    setShapeTarget({ center: toolCenterFromRight(tool), depth: TAB_DEPTH });
    showAnimated(drop);
    requestRender();
  }

  function onDropClick() {
    const disabled = dom.dropButton.getAttribute('aria-disabled') === 'true';
    if (!disabled) {
      if (mode === 'place') openPicker();
      else if (mode === 'delete') clearAllObjects();
    }
    showCaption(dom.dropButton.dataset.name, dom.dropButton);
  }


  /* 9. panels
     ------------------------------------------------------------------------
     only one of the picker or canvas properties is open at a time.
     ======================================================================== */

  let openPanel = null;

  function showAnimated(el) {
    clearTimeout(el._hideTimer);
    el.hidden = false;
    void el.offsetWidth; // start the transition from the closed state
    el.classList.add('is-open');
  }

  function hideAnimated(el) {
    el.classList.remove('is-open');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.hidden = true; }, PANEL_HIDE_DELAY);
  }

  function setOpenPanel(name) {
    openPanel = name;
    document.body.dataset.panel = name || 'none';
  }

  function closePanel() {
    if (!openPanel) return false;
    const closing = openPanel;
    setOpenPanel(null);
    if (closing === 'picker') {
      hideAnimated(dom.picker);
      dom.pickerSearch.blur();
    } else if (closing === 'help') {
      hideAnimated(dom.help);
      dom.helpButton.setAttribute('aria-expanded', 'false');
    } else if (closing === 'canvas') {
      hideAnimated(dom.canvasPanel);
      dom.canvasLabel.setAttribute('aria-expanded', 'false');
      // a color still being previewed from the wheel is kept, as one step
      if (backgroundPreview) setBackground(backgroundPreview);
    }
    return true;
  }


  /* 10. tools panel
     ======================================================================== */

  function setToolsExpanded(expanded) {
    // the modes live in the panel, so folding it away ends them
    if (!expanded && mode !== 'idle') setMode('idle');
    dom.tools.dataset.expanded = String(expanded);
    dom.toolsAnchor.setAttribute('aria-expanded', String(expanded));
    dom.toolsRow.inert = !expanded;
    setShapeTarget({ width: expanded ? expandedToolsWidth() : collapsedToolsWidth() });
    updateToolsCover();
  }

  // on narrow screens the expanded tools reach the upper-left corner; 🤔
  // then fades aside (it never moves) until the tools collapse again
  function updateToolsCover() {
    let cover = false;
    if (dom.tools.dataset.expanded === 'true') {
      const toolsRight = dom.toolsBar.getBoundingClientRect().right;
      const expandedWidth = dom.toolsAnchor.offsetWidth + dom.toolsRow.offsetWidth;
      // 🤔 sits in the corner, or beside the round canvas button
      const corner = dom.cornerBar;
      const cornerRight = corner.offsetLeft + corner.offsetWidth +
        (document.body.dataset.canvasButton === 'true' ? corner.offsetHeight + 8 : 0);
      cover = toolsRight - expandedWidth < cornerRight + 8;
    }
    document.body.dataset.toolsCover = String(cover);
  }

  function updateHistoryButtons() {
    dom.undoTool.setAttribute('aria-disabled', String(!canUndo()));
    dom.redoTool.setAttribute('aria-disabled', String(!canRedo()));
  }

  function onToolClick(event) {
    const button = event.target.closest('[data-tool]');
    if (!button) return;
    if (button.getAttribute('aria-disabled') === 'true') {
      showCaption(button.dataset.name, button);
      return;
    }

    // the drop-down tab belongs to the tool in use: tapping any other tool
    // ends that mode (and folds the tab away) before the new tool acts
    const tool = button.dataset.tool;
    const modeTool = mode === 'place' ? 'add' : mode === 'delete' ? 'delete' : null;
    if (modeTool && tool !== modeTool) setMode('idle');

    switch (tool) {
      case 'add':
        // the remembered emoji is ready at once; its tab under ➕ opens the
        // picker to change it
        if (mode === 'place') setMode('idle');
        else if (lastMaterial) selectMaterial(lastMaterial);
        else openPicker();
        break;
      case 'delete':
        closePanel();
        setMode(mode === 'delete' ? 'idle' : 'delete');
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'layers':
        toggleLayersPanel();
        break;
      case 'recenter':
        recenterView();
        break;
      case 'export':
        exportPng();
        break;
      default:
        break;
    }
    showCaption(button.dataset.name, button);
  }


  /* 11. canvas properties
     ======================================================================== */

  // 🤔 help: a short guide; opening and closing it changes nothing else
  // (the selection and the artwork stay as they are)
  function toggleHelp() {
    if (openPanel === 'help') {
      closePanel();
      return;
    }
    closePanel();
    closeObjectMenu();
    setOpenPanel('help');
    dom.helpButton.setAttribute('aria-expanded', 'true');
    dom.helpBody.scrollTop = 0;
    showAnimated(dom.help);
  }

  function openCanvasPanel() {
    if (openPanel === 'canvas') {
      closePanel();
      return;
    }
    closePanel();
    setOpenPanel('canvas');
    syncCanvasPanel();
    dom.canvasLabel.setAttribute('aria-expanded', 'true');
    showAnimated(dom.canvasPanel);
    positionCanvasPanel();
  }

  // place the panel above the label when it fits (keeping the canvas in
  // view while it changes shape), otherwise below; always inside the viewport
  function positionCanvasPanel() {
    const label = dom.canvasLabel.getBoundingClientRect();
    const toolsBottom = dom.toolsBar.getBoundingClientRect().bottom;
    const panelWidth = dom.canvasPanel.offsetWidth;
    const panelHeight = dom.canvasPanel.offsetHeight;
    const margin = 8;
    const above = label.top - 6 - panelHeight;
    const preferred = above >= toolsBottom + margin ? above : label.bottom + 6;
    const x = Math.min(Math.max(label.left, margin), viewportWidth - panelWidth - margin);
    const y = Math.min(Math.max(preferred, margin), viewportHeight - panelHeight - margin);
    dom.canvasPanel.style.left = Math.round(x) + 'px';
    dom.canvasPanel.style.top = Math.round(y) + 'px';
  }

  // background color: a swatch applies at once (one undo step); the color
  // wheel previews live while you pick and records one step when you're done
  let backgroundPreview = null;

  function setBackground(color) {
    backgroundPreview = null;
    const from = doc.canvas.background;
    const to = color.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(to) || from.toUpperCase() === to) {
      requestRender();
      return;
    }
    commit({ type: 'set-background', from, to });
  }

  function onColorClick(event) {
    // no caption here: the ring on the chosen swatch is the feedback
    const swatch = event.target.closest('[data-color]');
    if (swatch) setBackground(swatch.dataset.color);
  }

  function onColorInput() {
    backgroundPreview = dom.colorInput.value;
    requestRender();
  }

  function onColorChange() {
    setBackground(dom.colorInput.value);
  }

  function syncCanvasPanel() {
    const { width, height } = doc.canvas;
    const background = doc.canvas.background.toUpperCase();
    dom.swatches.forEach((swatch) => {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.color === background));
    });
    const custom = !dom.swatches.some((swatch) => swatch.dataset.color === background);
    dom.colorWheel.setAttribute('aria-pressed', String(custom));
    if (!backgroundPreview) dom.colorInput.value = background.toLowerCase();
    if (document.activeElement !== dom.widthInput) dom.widthInput.value = width;
    if (document.activeElement !== dom.heightInput) dom.heightInput.value = height;
    dom.ratioButtons.forEach((button) => {
      const active = Number(button.dataset.width) === width && Number(button.dataset.height) === height;
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function clampCanvasSize(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.min(CANVAS_MAX_SIZE, Math.max(CANVAS_MIN_SIZE, n));
  }

  function onCanvasSizeSubmit(event) {
    event.preventDefault();
    const width = clampCanvasSize(dom.widthInput.value);
    const height = clampCanvasSize(dom.heightInput.value);
    dom.widthInput.blur();
    dom.heightInput.blur();
    if (width === null || height === null) {
      syncCanvasPanel();
      return;
    }
    resizeCanvas(width, height);
    syncCanvasPanel();
  }

  function onRatioClick(event) {
    const button = event.target.closest('[data-width]');
    if (!button) return;
    resizeCanvas(Number(button.dataset.width), Number(button.dataset.height));
  }


  /* 12. emoji picker
     ======================================================================== */

  let pickerBuilt = false;
  const pickerSections = [];
  const pickerIndex = [];
  let pickerResults = null;
  let pickerScrollQueued = false;

  function buildPicker() {
    if (pickerBuilt) return;
    pickerBuilt = true;

    const navFragment = document.createDocumentFragment();
    const gridFragment = document.createDocumentFragment();

    EMOJI_CATEGORIES.forEach((category) => {
      const navButton = document.createElement('button');
      navButton.type = 'button';
      navButton.className = 'tool-button picker__category';
      navButton.dataset.category = category.id;
      navButton.setAttribute('aria-label', category.label);
      navButton.innerHTML = '<span class="emoji-icon" aria-hidden="true"></span>';
      navButton.firstChild.textContent = category.icon;
      navFragment.appendChild(navButton);

      const section = document.createElement('section');
      section.className = 'picker__section';
      section.dataset.category = category.id;
      const title = document.createElement('h2');
      title.className = 'picker__section-title';
      title.textContent = category.label;
      const items = document.createElement('div');
      items.className = 'picker__items';
      category.items.forEach(([emoji, name]) => {
        items.appendChild(createPickerButton(emoji, name));
        pickerIndex.push({ emoji, name });
      });
      section.append(title, items);
      gridFragment.appendChild(section);
      pickerSections.push({ id: category.id, section, navButton });
    });

    pickerResults = document.createElement('section');
    pickerResults.className = 'picker__section picker__results';
    pickerResults.hidden = true;
    gridFragment.appendChild(pickerResults);

    dom.pickerCategories.appendChild(navFragment);
    dom.pickerGrid.appendChild(gridFragment);
    if (EMOJI_CATEGORIES.length) setActiveCategory(EMOJI_CATEGORIES[0].id);
  }

  function createPickerButton(emoji, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker__emoji';
    button.dataset.emoji = emoji;
    button.setAttribute('aria-label', name);
    button.textContent = emoji;
    return button;
  }

  function openPicker() {
    buildPicker();
    if (openPanel === 'picker') return;
    closePanel();
    setOpenPanel('picker');
    dom.picker.dataset.size = 'compact';
    dom.pickerGrabber.setAttribute('aria-label', 'expand emoji picker');
    showAnimated(dom.picker);
    dom.picker.focus({ preventScroll: true });
  }

  function setPickerSize(size) {
    dom.picker.dataset.size = size;
    dom.pickerGrabber.setAttribute('aria-label',
      size === 'expanded' ? 'shrink emoji picker' : 'expand emoji picker');
  }

  function setActiveCategory(id) {
    pickerSections.forEach(({ id: sectionId, navButton }) => {
      navButton.setAttribute('aria-current', String(sectionId === id));
    });
  }

  function onPickerCategoryClick(event) {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    if (dom.pickerSearch.value) {
      dom.pickerSearch.value = '';
      applyPickerSearch();
    }
    const entry = pickerSections.find((s) => s.id === button.dataset.category);
    if (!entry) return;
    dom.pickerGrid.scrollTop = entry.section.offsetTop;
    setActiveCategory(entry.id);
  }

  function onPickerScroll() {
    if (pickerScrollQueued || dom.pickerSearch.value) return;
    pickerScrollQueued = true;
    requestAnimationFrame(() => {
      pickerScrollQueued = false;
      const top = dom.pickerGrid.scrollTop + 8;
      let current = pickerSections[0];
      for (const entry of pickerSections) {
        if (entry.section.offsetTop <= top) current = entry;
      }
      setActiveCategory(current.id);
    });
  }

  function applyPickerSearch() {
    const query = dom.pickerSearch.value.trim().toLowerCase();
    const searching = query.length > 0;
    pickerSections.forEach(({ section }) => { section.hidden = searching; });
    pickerResults.hidden = !searching;
    if (!searching) return;

    const terms = query.split(/\s+/);
    const matches = pickerIndex.filter(({ emoji, name }) =>
      emoji === query || terms.every((term) => name.includes(term)));

    pickerResults.textContent = '';
    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'picker__empty';
      empty.textContent = 'no matching emoji';
      pickerResults.appendChild(empty);
    } else {
      const items = document.createElement('div');
      items.className = 'picker__items';
      matches.forEach(({ emoji, name }) => items.appendChild(createPickerButton(emoji, name)));
      pickerResults.appendChild(items);
    }
    dom.pickerGrid.scrollTop = 0;
  }

  function onPickerGridClick(event) {
    const button = event.target.closest('[data-emoji]');
    if (button) selectMaterial(button.dataset.emoji);
  }

  // grabber: tap toggles size; drag up expands, drag down shrinks or closes
  function setupPickerGrabber() {
    let startY = null;
    let dragged = false;

    dom.pickerHeader.addEventListener('pointerdown', (event) => {
      if (event.target.closest('input, [data-category]')) return;
      startY = event.clientY;
      dragged = false;
    });

    dom.pickerHeader.addEventListener('pointermove', (event) => {
      if (startY === null) return;
      if (Math.abs(event.clientY - startY) > TAP_SLOP) dragged = true;
    });

    const finish = (event) => {
      if (startY === null) return;
      const dy = event.clientY - startY;
      startY = null;
      if (!dragged) return;
      if (dy < -30) setPickerSize('expanded');
      else if (dy > 30) {
        if (dom.picker.dataset.size === 'expanded') setPickerSize('compact');
        else closePanel();
      }
    };
    dom.pickerHeader.addEventListener('pointerup', finish);
    dom.pickerHeader.addEventListener('pointercancel', () => { startY = null; });

    dom.pickerGrabber.addEventListener('click', () => {
      if (dragged) {
        dragged = false;
        return;
      }
      setPickerSize(dom.picker.dataset.size === 'expanded' ? 'compact' : 'expanded');
    });
  }


  /* 13. export
     ------------------------------------------------------------------------
     ✅ renders the png straight from the document model at the canvas's own
     pixel dimensions, independent of zoom, and hands it to the browser's
     download. no preview, no dialog. only the canvas area is drawn, so the
     grid, the interface and anything outside the canvas are excluded, and
     objects crossing the edge are cropped.
     ======================================================================== */

  let exporting = false;

  function renderExport() {
    const { width, height, background } = doc.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    for (const object of doc.objects) {
      if (object.hidden) continue; // hidden layers never export
      const cx = object.x + width / 2;
      const cy = object.y + height / 2;
      const reach = object.size; // generous bound, covers rotation
      if (cx + reach < 0 || cx - reach > width || cy + reach < 0 || cy - reach > height) continue;
      drawEmoji(ctx, object, cx, cy, object.size);
    }

    return new Promise((resolve) => {
      try {
        canvas.toBlob(resolve, 'image/png');
      } catch (error) {
        resolve(null);
      }
    });
  }

  function exportFileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `moji-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  }

  function exportPng() {
    if (exporting) return;
    exporting = true;
    dom.exportTool.setAttribute('aria-busy', 'true');

    renderExport()
      .then((blob) => {
        if (!blob) throw new Error('png encoding failed');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = exportFileName();
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        // keep the url alive long enough for slower browsers to start the download
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })
      .catch(() => {
        showToast('export failed on this device');
      })
      .finally(() => {
        exporting = false;
        dom.exportTool.removeAttribute('aria-busy');
      });
  }


  /* 14. stage input
     ------------------------------------------------------------------------
     all positions are stage-relative (stagePoint), the same coordinates the
     renderer uses, so selection and editing stay aligned on iphone.

     touch
     - tap an emoji: select it (repeat on the same spot to cycle through
       overlapping emoji). tap empty space: deselect.
     - long press an emoji: select it and start editing; keep moving to drag.
     - while editing: drag the selection to move it, drag the corner handle
       to resize, the top handle to rotate, or use two fingers on it to do
       both. tap the selection to open its menu.
     - rest one finger on empty space and tap emoji with another finger to
       add or remove them from the selection.
     - two fingers anywhere else: pan and pinch-zoom the canvas.
     desktop
     - click selects, shift-click adds or removes, hold to edit, drag with
       the left or middle button on empty space to pan, wheel to zoom.
     ➕ and ➖ keep their own tap behavior (place / delete).
     while the timeline is open, the canvas can be navigated but not edited.
     ======================================================================== */

  const pointers = new Map();
  let gesture = null;
  let longPressTimer = null;

  function pointerPair() {
    const [a, b] = [...pointers.values()];
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  function movedBeyondSlop(pointer) {
    return Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > TAP_SLOP;
  }

  function cancelLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function startLongPress() {
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!gesture || gesture.kind !== 'press-object' || pointers.size !== 1) return;
      const hits = gesture.hits;
      // a long press on part of the current selection edits that selection
      // (including a lower emoji reached by cycling); otherwise the top one
      const inSelection = hits.find((o) => selection.ids.has(o.id));
      setSelection(inSelection ? selection.ids : unitIds(hits[0]), { editing: true });
      lastTap = null;
      gesture.kind = 'long-pressed';
      // a light tick where supported (only after the page has had a real tap)
      const activation = navigator.userActivation;
      if (navigator.vibrate && (!activation || activation.hasBeenActive)) navigator.vibrate(8);
    }, LONG_PRESS_MS);
  }

  function onStagePointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return;
    try { dom.stage.setPointerCapture(event.pointerId); } catch (e) { /* synthetic pointer */ }

    cancelViewAnimation();
    measureStage();
    noteInputType(event.pointerType);
    const p = stagePoint(event);
    const first = pointers.size === 0;
    pointers.set(event.pointerId, { x: p.x, y: p.y, startX: p.x, startY: p.y, downAt: performance.now() });

    if (first) {
      const onSelection = selection.editing && pointInFrame(p.x, p.y);
      // a tap that only closes a panel or the menu does nothing else
      const closed = closePanel() || (!onSelection && closeObjectMenu());
      gesture = {
        kind: 'pending',
        primaryId: event.pointerId,
        mouse: event.pointerType === 'mouse',
        shift: event.shiftKey,
        startX: p.x,
        startY: p.y,
        suppressed: closed || event.button !== 0,
        hits: [],
        pair: null,
        candidates: null,
        multiDone: false,
      };

      if (timeline.open || event.button === 1 || closed) {
        gesture.kind = 'navigate';
        // a plain tap outside the open timeline closes it (drags still pan)
        gesture.closesTimeline = timeline.open && !closed;
        return;
      }
      if (mode !== 'idle') {
        gesture.kind = 'mode-tap';
        return;
      }
      const handle = hitHandle(p.x, p.y);
      if (handle) {
        beginHandleGesture(handle, p);
        return;
      }
      // an emoji under the finger decides first, so taps on overlapping
      // emoji still cycle; empty space inside a multiple selection's
      // outline still grabs the whole selection
      gesture.hits = hitTestAll(p.x, p.y);
      if (gesture.hits.length) {
        gesture.kind = 'press-object';
        if (!gesture.hits.some((o) => selection.ids.has(o.id))) startLongPress();
      } else if (onSelection) {
        gesture.kind = 'on-selection';
      } else {
        gesture.kind = 'press-empty';
      }
      return;
    }

    if (!gesture) return;
    cancelLongPress();
    gesture.closesTimeline = false; // two fingers zoom; never a closing tap

    // a resting first finger on empty space + taps with another finger
    // builds a multiple selection
    const primary = pointers.get(gesture.primaryId);
    if ((gesture.kind === 'press-empty' || gesture.kind === 'multi') && !gesture.mouse &&
        primary && !movedBeyondSlop(primary)) {
      gesture.kind = 'multi';
      gesture.candidates = gesture.candidates || new Map();
      gesture.candidates.set(event.pointerId, { x: p.x, y: p.y, downAt: performance.now() });
      return;
    }

    // two fingers on an active selection transform it
    const onSelected = gesture.kind === 'press-object' && gesture.hits.some((o) => selection.ids.has(o.id));
    if (pointers.size === 2 && selection.editing &&
        (onSelected || ['on-selection', 'long-pressed', 'drag'].includes(gesture.kind) ||
         (gesture.kind !== 'navigate' && pointInFrame(pointerPair().midX, pointerPair().midY, 40)))) {
      if (!transform) beginTransform();
      else rebaseTransform();
      gesture.kind = 'pinch-transform';
      gesture.pair = pointerPair();
      return;
    }

    // otherwise: canvas navigation
    if (transform) endTransform();
    gesture.kind = 'navigate';
    gesture.pair = pointers.size >= 2 ? pointerPair() : null;
  }

  function beginHandleGesture(handle, p) {
    if (!beginTransform()) return;
    const center = worldToScreen(selection.frame.cx, selection.frame.cy);
    gesture.kind = handle;
    gesture.center = center;
    gesture.startDistance = Math.max(1, Math.hypot(p.x - center.x, p.y - center.y));
    gesture.startAngle = Math.atan2(p.y - center.y, p.x - center.x);
  }

  function onStagePointerMove(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer || !gesture) return;
    const lastX = pointer.x;
    const lastY = pointer.y;
    const p = stagePoint(event);
    pointer.x = p.x;
    pointer.y = p.y;
    const isPrimary = event.pointerId === gesture.primaryId;
    const moved = movedBeyondSlop(pointer);

    switch (gesture.kind) {
      case 'press-object':
        // an emoji that is already selected moves at once, without a long
        // press; the press never changes the selection, so a lower emoji
        // reached by cycling stays the one that moves
        if (isPrimary && moved) {
          cancelLongPress();
          // (editing stays as it was, so later taps still cycle overlaps)
          if (!gesture.shift && gesture.hits.some((o) => selection.ids.has(o.id)) && beginTransform()) {
            gesture.kind = 'drag';
            dragTo(pointer);
          } else {
            gesture.kind = gesture.mouse ? 'pan' : 'idle-move';
          }
        }
        break;
      case 'press-empty':
      case 'mode-tap':
        if (isPrimary && moved) {
          cancelLongPress();
          gesture.kind = gesture.mouse ? 'pan' : 'idle-move';
        }
        break;
      case 'navigate':
        if (pointers.size >= 2) navigateWithPair();
        else if (gesture.mouse && isPrimary && moved) panBy(p.x - lastX, p.y - lastY);
        break;
      case 'pan':
        panBy(p.x - lastX, p.y - lastY);
        break;
      case 'on-selection':
      case 'long-pressed':
        if (isPrimary && moved && beginTransform()) {
          gesture.kind = 'drag';
          dragTo(pointer);
        }
        break;
      case 'drag':
        if (isPrimary) dragTo(pointer);
        break;
      case 'scale': {
        const d = Math.hypot(p.x - gesture.center.x, p.y - gesture.center.y);
        applyTransform(0, 0, d / gesture.startDistance, 0);
        break;
      }
      case 'rotate': {
        const a = Math.atan2(p.y - gesture.center.y, p.x - gesture.center.x);
        applyTransform(0, 0, 1, a - gesture.startAngle);
        break;
      }
      case 'pinch-transform':
        if (pointers.size >= 2) {
          const pair = pointerPair();
          const start = gesture.pair;
          applyTransform(
            (pair.midX - start.midX) / view.scale,
            (pair.midY - start.midY) / view.scale,
            start.distance > 0 ? pair.distance / start.distance : 1,
            pair.angle - start.angle
          );
        }
        break;
      case 'multi': {
        // fingers that travel turn the gesture back into navigation
        const candidate = gesture.candidates && gesture.candidates.get(event.pointerId);
        const travelled = candidate ? Math.hypot(p.x - candidate.x, p.y - candidate.y) > TAP_SLOP : moved;
        if (travelled && pointers.size >= 2) {
          gesture.kind = 'navigate';
          gesture.candidates = null;
          gesture.pair = pointerPair();
        }
        break;
      }
      default:
        break;
    }
  }

  function dragTo(pointer) {
    applyTransform(
      (pointer.x - pointer.startX) / view.scale,
      (pointer.y - pointer.startY) / view.scale,
      1,
      0
    );
  }

  function navigateWithPair() {
    const pair = pointerPair();
    const previous = gesture.pair || pair;
    if (previous.distance > 0) zoomAt(previous.midX, previous.midY, pair.distance / previous.distance);
    panBy(pair.midX - previous.midX, pair.midY - previous.midY);
    gesture.pair = pair;
  }

  function onStagePointerEnd(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    pointers.delete(event.pointerId);
    if (!gesture) return;
    const p = stagePoint(event);

    // a quick second-finger tap during the multiple-selection gesture
    if (gesture.kind === 'multi' && event.pointerId !== gesture.primaryId) {
      const candidate = gesture.candidates && gesture.candidates.get(event.pointerId);
      if (candidate && event.type === 'pointerup' &&
          Math.hypot(p.x - candidate.x, p.y - candidate.y) <= TAP_SLOP &&
          performance.now() - candidate.downAt <= MULTI_TAP_MS) {
        const hit = hitTest(p.x, p.y);
        if (hit) {
          toggleUnit(hit);
          gesture.multiDone = true;
        }
      }
      if (gesture.candidates) gesture.candidates.delete(event.pointerId);
      if (pointers.size > 0) return;
    }

    if (pointers.size > 0) {
      if (gesture.kind === 'pinch-transform') {
        // one finger left: the gesture ends here (one history step)
        endTransform();
        gesture.kind = 'done';
      } else if (gesture.kind === 'navigate') {
        gesture.pair = pointers.size >= 2 ? pointerPair() : null;
      }
      return;
    }

    cancelLongPress();
    const tap = event.type === 'pointerup' && !gesture.suppressed &&
      event.pointerId === gesture.primaryId && !movedBeyondSlop(pointer);

    switch (gesture.kind) {
      case 'navigate':
        if (tap && gesture.closesTimeline && timeline.open) closeTimeline();
        break;
      case 'mode-tap':
        if (tap) handleModeTap(p.x, p.y);
        break;
      case 'press-object':
        if (tap) handleObjectTap(p.x, p.y, gesture.hits, gesture.shift);
        break;
      case 'press-empty':
        if (tap && !gesture.shift) clearSelection();
        break;
      case 'multi':
        if (tap && !gesture.multiDone) clearSelection();
        break;
      case 'on-selection':
        if (tap) {
          if (gesture.shift) {
            const hit = hitTest(p.x, p.y);
            if (hit) toggleUnit(hit);
          } else if (menuOpen) closeObjectMenu();
          else openObjectMenu();
        }
        break;
      case 'drag':
      case 'scale':
      case 'rotate':
      case 'pinch-transform':
        endTransform();
        break;
      default:
        break;
    }
    gesture = null;
  }

  // placement and delete modes
  function handleModeTap(sx, sy) {
    if (mode === 'place' && material) {
      // one emoji per placement: placing ends ➕ and selects the new emoji,
      // ready to move, resize, rotate or open its menu (selection is not a
      // history step; the placement is one)
      const point = screenToWorld(sx, sy);
      const object = placeEmoji(material, point.x, point.y);
      setMode('idle');
      setSelection([object.id]);
    } else if (mode === 'delete') {
      const hit = hitTest(sx, sy);
      if (hit) deleteObject(hit);
    }
  }

  // a tap on an emoji:
  //   not selected        → select it (top one under the finger)
  //   selected, and alone under the finger → open or close its menu
  //   selected, but other emoji overlap here → select the next one down
  //                         (cycling wins where they overlap; tap a part of
  //                         the selected emoji that nothing else covers, or
  //                         empty space inside a multiple selection, for the menu)
  // nothing ever moves on a tap
  function handleObjectTap(sx, sy, hits, shift) {
    if (shift) {
      toggleUnit(hits[0]);
      return;
    }
    const units = [];
    const seen = new Set();
    hits.forEach((o) => {
      const key = unitKey(o);
      if (!seen.has(key)) {
        seen.add(key);
        units.push(o);
      }
    });
    const isSelection = (o) => {
      const ids = unitIds(o);
      return ids.length === selection.ids.size && ids.every((id) => selection.ids.has(id));
    };
    const current = units.findIndex(isSelection);
    const touchesSelection = hits.some((o) => selection.ids.has(o.id));

    if (units.length > 1 && current !== -1) {
      closeObjectMenu();
      setSelection(unitIds(units[(current + 1) % units.length]));
      return;
    }
    if (touchesSelection && (units.length === 1 || current === -1)) {
      if (menuOpen) closeObjectMenu();
      else openObjectMenu();
      return;
    }
    setSelection(unitIds(units[0]));
  }

  function onStageWheel(event) {
    event.preventDefault();
    cancelViewAnimation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
    // purely horizontal scrolling has no zoom meaning; ignore it
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : 0) * unit;
    if (!delta) return;
    measureStage();
    const p = stagePoint(event);

    if (event.ctrlKey || event.metaKey) {
      // trackpad pinch (browsers report it as ctrl + wheel), or ctrl/⌘ + wheel
      const step = Math.max(-60, Math.min(60, delta));
      zoomAt(p.x, p.y, Math.exp(-step * PINCH_ZOOM_SPEED));
    } else {
      // mouse wheel or trackpad scroll: one consistent behavior, zoom
      const step = Math.max(-120, Math.min(120, delta));
      zoomAt(p.x, p.y, Math.exp(-step * WHEEL_ZOOM_SPEED));
    }
  }


  /* 15. keyboard and global guards
     ======================================================================== */

  // ⌘/ctrl + c copies the selection, + v pastes it, + d duplicates it.
  // typing in a field keeps the browser's own copy and paste.
  function onShortcut(event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
    const key = event.key.toLowerCase();
    if (key !== 'c' && key !== 'v' && key !== 'd') return false;
    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return false;
    if (timeline.open || layers.drag || transform) return false;
    if (key === 'd') {
      event.preventDefault(); // not the browser's bookmark shortcut
      if (selection.ids.size) {
        closeObjectMenu();
        duplicateSelection();
      }
      return true;
    }
    if (key === 'c') {
      if (copySelection()) event.preventDefault();
      return true;
    }
    if (pasteClipboard()) event.preventDefault();
    return true;
  }

  function onKeyDown(event) {
    if (onShortcut(event)) return;
    if (event.key !== 'Escape') return;
    if (layers.drag) {
      cancelLayerDrag();
      return;
    }
    if (timeline.open) {
      if (timeline.branchesOpen) closeBranches();
      else closeTimeline();
      return;
    }
    if (closePanel()) return;
    if (closeObjectMenu()) return;
    if (closeLayersPanel()) return;
    if (mode !== 'idle') {
      setMode('idle');
      return;
    }
    if (selection.ids.size) {
      clearSelection();
      return;
    }
    if (dom.tools.dataset.expanded === 'true') setToolsExpanded(false);
  }

  function installGlobalGuards() {
    // stop ios safari from zooming the page itself
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
      document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
    });
    dom.stage.addEventListener('contextmenu', (event) => event.preventDefault());
    // long presses and drags never select text anywhere (fields excepted)
    document.addEventListener('selectstart', (event) => {
      const target = event.target;
      const field = target && target.closest && target.closest('input, textarea');
      if (!field) event.preventDefault();
    });
    // a ctrl+wheel (trackpad pinch) over the interface must never zoom the page
    window.addEventListener('wheel', (event) => {
      if (event.ctrlKey) event.preventDefault();
    }, { passive: false });
  }


  /* 16. autosave (local persistence)
     ------------------------------------------------------------------------
     the whole project (every branch, its history and names, the active
     branch, plus a safety copy of the current artwork) is saved to
     localStorage a moment after each change and whenever the page is
     hidden. timeline previews are never saved as the artwork.

     on startup the project is validated and rebuilt by replaying history;
     it must reproduce the safety copy. 0.0.1 projects are converted (the
     original data is kept under a backup key first). if history cannot be
     read, the artwork is kept, the raw data is backed up, and a new history
     starts. nothing is discarded silently: if storage fills up, saving
     pauses with a message instead of dropping branches.

     local browser storage is not a backup: browsers or users may clear it.
     ======================================================================== */

  let storage = null;
  let saveTimer = null;
  let saveNeeded = false;
  let storageFullWarned = false;

  function openStorage() {
    try {
      const s = window.localStorage;
      const probe = 'moji.__probe';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (error) {
      return null;
    }
  }

  function scheduleSave() {
    if (!storage) return;
    saveNeeded = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!storage || !saveNeeded || !project) return;
    saveNeeded = false;
    try {
      storage.setItem(STORAGE_KEY, H.serialize(project, doc));
      storageFullWarned = false;
    } catch (error) {
      saveNeeded = true; // try again with the next change
      if (!storageFullWarned) {
        storageFullWarned = true;
        showToast('storage is full: recent changes are not saved. deleting a branch frees space');
      }
    }
  }

  function freshProject() {
    project = H.createProject({ canvas: { ...DEFAULT_CANVAS }, objects: [] });
  }

  function keepCopy(key, raw) {
    try {
      storage.setItem(key, raw);
      return true;
    } catch (error) {
      return false;
    }
  }

  function restoreProject() {
    storage = openStorage();
    let raw = null;
    if (storage) {
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch (error) {
        storage = null;
      }
    } else {
      showToast('autosave is unavailable in this browser');
    }

    if (raw) {
      let result = null;
      try {
        result = H.parse(raw, { canvas: { ...DEFAULT_CANVAS } });
      } catch (error) {
        result = null;
      }

      if (!result) {
        // keep the unreadable data before any new save can replace it
        if (keepCopy(STORAGE_BACKUP_KEY, raw)) showToast('the saved project could not be opened; a copy was kept');
        else {
          storage = null;
          showToast('the saved project could not be opened; autosave is paused');
        }
        freshProject();
      } else {
        project = result.project;
        if (result.migrated) keepCopy(STORAGE_V1_BACKUP_KEY, raw);
        if (result.damaged) keepCopy(STORAGE_BACKUP_KEY, raw);
        if (result.notice) showToast(result.notice);
        if (result.migrated || result.damaged) {
          saveNeeded = true;
          setTimeout(saveNow, 0);
        }
      }
    } else {
      freshProject();
    }

    setLiveState(H.latestState(project, project.activeId));
    nextOrder = computeNextOrder();
  }

  function installSaveTriggers() {
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }


  /* 17. timeline
     ------------------------------------------------------------------------
     ⏳ opens the history of the active branch. dragging the playhead
     rebuilds the artwork at that moment (instantly, no animation); ▶️ plays
     the process back, animating each event between its before and after
     states at a steady rhythm. previews never touch the live artwork: the
     stage simply draws the preview instead, and closing returns to the
     latest state with the previous mode and selection.

     🌱 start from here makes a new branch at the previewed moment (up to
     five branches per project). 🌿 lists branches to switch, rename or
     delete them.
     ======================================================================== */

  const timeline = {
    open: false,
    events: [],
    total: 0,
    index: 0,          // whole events applied in the preview
    position: 0,       // index plus playback progress, for the playhead
    scene: null,       // { canvas, objects } being shown, or null for the live artwork
    playing: false,
    speedIndex: 1,
    frame: null,
    playState: null,
    pending: null,     // the step being animated: { index, after }
    saved: null,       // mode and selection to restore on close
    branchesOpen: false,
    confirmId: null,
    renamingId: null,
    message: '',
    messageTimer: null,
  };

  function scene() {
    return timeline.open && timeline.scene ? timeline.scene : doc;
  }

  function activeBranch() {
    return H.getBranch(project, project.activeId);
  }

  function openTimeline() {
    if (timeline.open) return;
    closePanel();
    closeObjectMenu();
    timeline.saved = {
      mode,
      material,
      ids: [...selection.ids],
      editing: selection.editing,
    };
    if (mode !== 'idle') setMode('idle');
    selection.ids = new Set();
    selection.editing = false;
    selection.frame = null;

    timeline.open = true;
    timeline.message = '';
    refreshTimelineData();
    timeline.index = timeline.total;
    timeline.position = timeline.total;
    timeline.scene = null;
    document.body.dataset.timeline = 'open';
    dom.toolsBar.inert = true;
    dom.canvasLabel.inert = true;
    dom.timeline.dataset.open = 'true';
    dom.timelineToggle.setAttribute('aria-expanded', 'true');
    dom.timelinePanel.inert = false;
    renderTimelineUi();
    requestAnimationFrame(drawTimelineTicks);
    requestRender();
  }

  function closeTimeline(options = {}) {
    if (!timeline.open) return;
    stopPlayback(false);
    closeBranches();
    timeline.open = false;
    timeline.scene = null;
    timeline.playState = null;
    document.body.dataset.timeline = 'closed';
    dom.toolsBar.inert = false;
    dom.canvasLabel.inert = false;
    dom.timeline.dataset.open = 'false';
    dom.timelineToggle.setAttribute('aria-expanded', 'false');
    dom.timelinePanel.inert = true;
    disarmReset();
    refreshClosedTimeline(false);

    const saved = timeline.saved;
    timeline.saved = null;
    if (options.restore !== false && saved) {
      if (saved.mode === 'place' && saved.material) selectMaterial(saved.material);
      else if (saved.mode === 'delete') {
        setToolsExpanded(true);
        setMode('delete');
      } else {
        const existing = new Set(doc.objects.map((o) => o.id));
        const ids = saved.ids.filter((id) => existing.has(id));
        if (ids.length) setSelection(ids, { editing: saved.editing });
      }
    }
    updateHistoryButtons();
    requestRender();
  }

  function refreshTimelineData() {
    timeline.events = H.chronology(project, project.activeId);
    timeline.total = timeline.events.length;
  }

  function showStateAt(k) {
    timeline.index = Math.max(0, Math.min(k, timeline.total));
    timeline.position = timeline.index;
    timeline.scene = timeline.index >= timeline.total
      ? null
      : H.stateAt(project, project.activeId, timeline.index);
    renderTimelineUi();
    requestRender();
  }

  function scrubTo(k) {
    stopPlayback(false);
    showStateAt(k);
  }

  // what the most recent event in the preview did, in a word or two
  function describeEvent(event) {
    if (!event) return 'start';
    if (event.type === 'undo') return 'undo';
    if (event.type === 'redo') return 'redo';
    const op = event.op;
    switch (op.type) {
      case 'add-object':
        return 'add';
      case 'add-objects':
        return op.label === 'duplicate' || op.label === 'paste' ? op.label : 'add';
      case 'delete-object':
      case 'delete-objects':
        return op.label === 'delete all' ? 'delete all' : 'delete';
      case 'clear-objects':
        return 'delete all';
      case 'resize-canvas':
        return 'canvas size';
      case 'set-background':
        return 'background';
      case 'transform-objects':
        return op.label || 'move';
      case 'set-groups':
        return op.label || 'group';
      case 'reorder':
        return { front: 'to front', back: 'to back', forward: 'forward', backward: 'backward' }[op.label] || 'reorder';
      case 'arrange':
        return op.label || 'layers';
      case 'set-flags':
        return op.label || 'layer';
      default:
        return op.type;
    }
  }

  function renderTimelineUi() {
    const branch = activeBranch();
    const total = timeline.total;
    const atEnd = timeline.index >= total;
    let status;
    if (total === 0) status = `${branch.name} · nothing to show yet`;
    else if (atEnd && !timeline.playing) status = `${branch.name} · now`;
    else if (timeline.position <= 0) status = `${branch.name} · start`;
    else {
      const step = Math.min(total, Math.max(1, Math.ceil(timeline.position)));
      status = `${branch.name} · ${step} of ${total} · ${describeEvent(timeline.events[step - 1])}`;
    }
    dom.timelineStatus.textContent = timeline.message || status;
    // messages may take two lines; the usual status stays on one
    dom.timelineStatus.dataset.message = String(Boolean(timeline.message));
    // a long branch name or step label wraps instead of being cut off
    dom.timelineStatus.dataset.long = String(dom.timelineStatus.textContent.length > 34);

    const fraction = total ? timeline.position / total : 1;
    dom.timelineFill.style.width = (fraction * 100) + '%';
    dom.timelineKnob.style.left = (fraction * 100) + '%';
    dom.timelineScrubber.setAttribute('aria-valuemax', String(total));
    dom.timelineScrubber.setAttribute('aria-valuenow', String(timeline.index));
    dom.timelineScrubber.setAttribute('aria-valuetext', status);
    dom.timelineScrubber.setAttribute('aria-disabled', String(total === 0));

    dom.playButton.querySelector('.emoji-icon').textContent = timeline.playing ? '⏸️' : '▶️';
    dom.playButton.dataset.name = timeline.playing ? 'pause' : 'play';
    dom.playButton.setAttribute('aria-label', timeline.playing ? 'pause' : 'play');
    dom.playButton.setAttribute('aria-disabled', String(total === 0));
    dom.speedButton.textContent = PLAYBACK_SPEEDS[timeline.speedIndex] + '×';

    // 🌱 only while looking at an earlier moment
    dom.branchHereButton.hidden = atEnd || timeline.playing;
    dom.branchHereButton.setAttribute('aria-disabled', String(!H.canCreateBranch(project)));
  }

  // tick marks for every event (undo and redo in the accent color) and
  // dots where this branch left its ancestors
  function drawTimelineTicks() {
    const canvas = dom.timelineTicks;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const total = timeline.total;
    if (!total) return;
    // one tick per event while they fit (3px apart); after that each tick
    // stands for a few neighboring events, so the strip keeps showing work
    const bins = Math.max(1, Math.min(total, Math.floor(width / 3)));
    for (let b = 0; b < bins; b += 1) {
      const first = Math.floor((b * total) / bins);
      const last = Math.floor(((b + 1) * total) / bins);
      let undoRedo = false;
      for (let i = first; i < last; i += 1) {
        if (timeline.events[i].type !== 'op') undoRedo = true;
      }
      const x = Math.round((last / total) * width) - 0.5;
      ctx.fillStyle = undoRedo ? 'rgba(245, 160, 0, 0.75)' : 'rgba(29, 29, 31, 0.22)';
      ctx.fillRect(x, height / 2 - 4, 1, 8);
    }
    H.branchPoints(project, project.activeId).forEach((point) => {
      const x = (point / total) * width;
      ctx.beginPath();
      ctx.arc(x, height / 2, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#34C759';
      ctx.fill();
    });
  }

  // scrubbing: pointer on the rail moves the playhead; state appears at once
  // the closed strip works the same way: touching it opens the timeline at
  // that moment. after the first touch the playhead follows the finger's
  // movement (not its absolute position), so it never jumps while the
  // strip widens into the open timeline.
  function setupScrubber() {
    const clamp = (f) => Math.min(1, Math.max(0, f));
    let drag = null;
    dom.timelineScrubber.addEventListener('pointerdown', (event) => {
      if (!timeline.total) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      try { dom.timelineScrubber.setPointerCapture(event.pointerId); } catch (e) { /* synthetic */ }
      const rect = dom.timelineScrubber.getBoundingClientRect();
      const fraction = clamp((event.clientX - rect.left) / rect.width);
      drag = { id: event.pointerId, x: event.clientX, fraction };
      if (!timeline.open) openTimeline();
      scrubTo(Math.round(fraction * timeline.total));
    });
    dom.timelineScrubber.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const width = dom.timelineScrubber.getBoundingClientRect().width || 1;
      const fraction = clamp(drag.fraction + (event.clientX - drag.x) / width);
      const k = Math.round(fraction * timeline.total);
      if (k !== timeline.index) scrubTo(k);
    });
    const stop = () => { drag = null; };
    dom.timelineScrubber.addEventListener('pointerup', stop);
    dom.timelineScrubber.addEventListener('pointercancel', stop);
    dom.timelineScrubber.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
      const known = step || event.key === 'Home' || event.key === 'End';
      if (known && timeline.total && !timeline.open) openTimeline();
      if (step) {
        event.preventDefault();
        scrubTo(timeline.index + step);
      } else if (event.key === 'Home') scrubTo(0);
      else if (event.key === 'End') scrubTo(timeline.total);
    });
  }

  // playback: one event after another at a steady rhythm. each step
  // interpolates only what that event changed (appear, disappear, move,
  // resize, rotate, canvas size); everything else stays still.
  function startPlayback() {
    if (!timeline.total) return;
    closeBranches();
    if (timeline.index >= timeline.total) showStateAt(0);
    timeline.playing = true;
    timeline.playState = H.stateAt(project, project.activeId, timeline.index);
    renderTimelineUi();
    playNextStep();
  }

  function playNextStep() {
    if (!timeline.playing) return;
    if (timeline.index >= timeline.total) {
      stopPlayback(false);
      showStateAt(timeline.total);
      return;
    }
    const state = timeline.playState;
    const before = { canvas: state.canvas, objects: state.objects };
    H.step(state, timeline.events[timeline.index]);
    const after = { canvas: state.canvas, objects: state.objects };
    const transition = H.makeTransition(before, after);
    const speed = PLAYBACK_SPEEDS[timeline.speedIndex];
    const duration = (transition.visible ? PLAYBACK_STEP_MS : PLAYBACK_STEP_MS * 0.4) / speed;
    const from = timeline.index;
    const startTime = performance.now();
    timeline.pending = { index: from + 1, after };

    const frame = (now) => {
      if (!timeline.playing) return;
      const t = Math.min(1, (now - startTime) / duration);
      // motion takes most of the step, then a short rest; reduced motion
      // shows each result at once
      const motion = reducedMotion.matches ? 1 : easeInOut(Math.min(1, t / 0.75));
      timeline.scene = H.sceneAt(transition, motion);
      timeline.position = from + t;
      renderTimelineUi();
      requestRender();
      if (t < 1) {
        timeline.frame = requestAnimationFrame(frame);
      } else {
        timeline.index = from + 1;
        timeline.scene = after;
        timeline.pending = null;
        playNextStep();
      }
    };
    timeline.frame = requestAnimationFrame(frame);
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  // pausing finishes the step in progress so the preview shows a real state
  function stopPlayback(render = true) {
    if (!timeline.playing) return;
    timeline.playing = false;
    cancelAnimationFrame(timeline.frame);
    if (timeline.pending) {
      timeline.index = timeline.pending.index;
      timeline.scene = timeline.pending.after;
      timeline.pending = null;
    }
    timeline.position = timeline.index;
    if (timeline.index >= timeline.total) timeline.scene = null;
    if (render) {
      renderTimelineUi();
      requestRender();
    }
  }

  // while closed, the strip follows the work: a new tick for every change
  function refreshClosedTimeline(bump) {
    if (timeline.open || !dom.timeline) return;
    const before = timeline.total;
    refreshTimelineData();
    timeline.index = timeline.total;
    timeline.position = timeline.total;
    renderTimelineUi();
    drawTimelineTicks();
    if (bump && timeline.total !== before) {
      const knob = dom.timelineKnob;
      knob.classList.remove('is-bumped');
      void knob.offsetWidth; // restart the animation
      knob.classList.add('is-bumped');
    }
  }

  // reset: starts the whole project over (default canvas, no emoji, no
  // steps, one branch). asks once more before it happens; cannot be undone.
  function resetTimeline() {
    if (!timeline.resetArmed) {
      timeline.resetArmed = true;
      dom.resetButton.dataset.confirm = 'true';
      dom.resetButton.textContent = 'sure?';
      showTimelineMessage('tap sure? to erase every emoji, step and branch');
      clearTimeout(timeline.resetTimer);
      timeline.resetTimer = setTimeout(disarmReset, 4200);
      return;
    }
    disarmReset();
    stopPlayback(false);
    closeBranches();
    // a fresh project: default canvas, no emoji, no history, one branch
    project = H.createProject({ canvas: { ...DEFAULT_CANVAS }, objects: [] });
    setLiveState(H.latestState(project, project.activeId));
    nextOrder = 1;
    backgroundPreview = null;
    if (timeline.saved) {
      timeline.saved.ids = [];
      timeline.saved.editing = false;
    }
    refreshTimelineData();
    showStateAt(timeline.total);
    drawTimelineTicks();
    updateHistoryButtons();
    syncCanvasPanel();
    saveNeeded = true;
    saveNow();
    recenterView();
    showTimelineMessage('everything reset');
  }

  function disarmReset() {
    clearTimeout(timeline.resetTimer);
    timeline.resetArmed = false;
    if (!dom.resetButton) return;
    delete dom.resetButton.dataset.confirm;
    dom.resetButton.textContent = 'reset';
  }

  function showTimelineMessage(text) {
    timeline.message = text;
    renderTimelineUi();
    clearTimeout(timeline.messageTimer);
    timeline.messageTimer = setTimeout(() => {
      timeline.message = '';
      if (timeline.open) renderTimelineUi();
    }, 4200);
  }

  // 🌱: a new branch from the previewed moment becomes the active branch
  function startFromHere() {
    if (timeline.index >= timeline.total) return;
    if (!H.canCreateBranch(project)) {
      showTimelineMessage(`${H.MAX_BRANCHES} branches is the limit. delete one in 🌿 first`);
      return;
    }
    const branch = H.createBranch(project, project.activeId, timeline.index);
    project.activeId = branch.id;
    setLiveState(H.latestState(project, branch.id));
    selection.ids = new Set();
    selection.editing = false;
    selection.frame = null;
    closeTimeline({ restore: false });
    onDocumentChanged();
    showCaption(branch.name, dom.timelineToggle);
  }

  function switchBranch(id) {
    if (id === project.activeId || !H.getBranch(project, id)) return;
    stopPlayback(false);
    project.activeId = id;
    setLiveState(H.latestState(project, id));
    // the selection belongs to the branch you left
    if (timeline.saved) {
      timeline.saved.ids = [];
      timeline.saved.editing = false;
    }
    refreshTimelineData();
    showStateAt(timeline.total);
    drawTimelineTicks();
    updateHistoryButtons();
    syncCanvasPanel();
    scheduleSave();
    renderBranches();
  }

  function openBranches() {
    stopPlayback();
    timeline.branchesOpen = true;
    timeline.confirmId = null;
    timeline.renamingId = null;
    renderBranches();
    showAnimated(dom.branches);
  }

  function closeBranches() {
    if (!timeline.branchesOpen) return;
    timeline.branchesOpen = false;
    timeline.confirmId = null;
    timeline.renamingId = null;
    hideAnimated(dom.branches);
  }

  function renderBranches() {
    const list = dom.branchesList;
    list.textContent = '';
    dom.branchesCount.textContent = `${project.branches.length} of ${H.MAX_BRANCHES}`;
    const only = project.branches.length <= 1;

    project.branches.forEach((branch) => {
      const active = branch.id === project.activeId;
      const row = document.createElement('li');
      row.className = 'branch-row';
      row.dataset.id = branch.id;
      if (active) row.dataset.active = 'true';

      if (timeline.confirmId === branch.id) {
        row.dataset.confirm = 'true';
        const text = document.createElement('span');
        text.className = 'branch-row__confirm';
        text.textContent = `delete “${branch.name}”?`;
        row.append(text,
          branchButton('confirm-delete', 'delete', 'branch-row__danger', 'delete branch'),
          branchButton('cancel-delete', 'keep', 'branch-row__plain', 'keep branch'));
      } else if (timeline.renamingId === branch.id) {
        const input = document.createElement('input');
        input.className = 'branch-row__input';
        input.value = branch.name;
        input.maxLength = 40;
        input.setAttribute('aria-label', 'branch name');
        input.dataset.branchInput = branch.id;
        row.append(input, branchButton('save-name', 'done', 'branch-row__plain', 'save name'));
      } else {
        const name = branchButton('switch', branch.name, 'branch-row__name', active ? `${branch.name}, current branch` : `switch to ${branch.name}`);
        const meta = document.createElement('span');
        meta.className = 'branch-row__meta';
        const count = H.chronology(project, branch.id).length;
        meta.textContent = active ? 'current' : `${count} ${count === 1 ? 'step' : 'steps'}`;
        const rename = branchButton('rename', '✏️', 'tool-button branch-row__icon', `rename ${branch.name}`);
        rename.dataset.name = 'rename';
        const remove = branchButton('delete', '🗑️', 'tool-button branch-row__icon', `delete ${branch.name}`);
        remove.dataset.name = active ? 'switch branches first' : only ? 'last branch' : 'delete';
        if (active || only) remove.setAttribute('aria-disabled', 'true');
        row.append(name, meta, rename, remove);
      }
      list.appendChild(row);
    });

    const input = list.querySelector('[data-branch-input]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function branchButton(action, label, className, ariaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.branchAction = action;
    button.setAttribute('aria-label', ariaLabel);
    if (className.includes('tool-button')) {
      const icon = document.createElement('span');
      icon.className = 'emoji-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = label;
      button.appendChild(icon);
    } else if (className.includes('branch-row__name')) {
      const text = document.createElement('span');
      text.className = 'branch-row__label';
      text.textContent = label;
      button.appendChild(text);
    } else {
      button.textContent = label;
    }
    return button;
  }

  function saveBranchName(id) {
    const input = dom.branchesList.querySelector(`[data-branch-input="${id}"]`);
    if (input) H.renameBranch(project, id, input.value);
    timeline.renamingId = null;
    renderBranches();
    renderTimelineUi();
    scheduleSave();
  }

  function onBranchesClick(event) {
    const button = event.target.closest('[data-branch-action]');
    if (!button) return;
    const id = button.closest('[data-id]').dataset.id;
    const action = button.dataset.branchAction;
    if (button.dataset.name) showCaption(button.dataset.name, button);
    if (button.getAttribute('aria-disabled') === 'true') return;

    if (action === 'switch') switchBranch(id);
    else if (action === 'rename') {
      timeline.renamingId = id;
      timeline.confirmId = null;
      renderBranches();
    } else if (action === 'save-name') saveBranchName(id);
    else if (action === 'delete') {
      timeline.confirmId = id;
      timeline.renamingId = null;
      renderBranches();
    } else if (action === 'cancel-delete') {
      timeline.confirmId = null;
      renderBranches();
    } else if (action === 'confirm-delete') {
      H.deleteBranch(project, id);
      timeline.confirmId = null;
      refreshTimelineData();
      drawTimelineTicks();
      renderBranches();
      renderTimelineUi();
      scheduleSave();
    }
  }

  function onBranchesKeyDown(event) {
    const input = event.target.closest('[data-branch-input]');
    if (!input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      saveBranchName(input.dataset.branchInput);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      timeline.renamingId = null;
      renderBranches();
    }
  }

  function onTimelineControlClick(event) {
    const button = event.target.closest('[data-timeline]');
    if (!button) return;
    const action = button.dataset.timeline;
    if (action !== 'branch' || button.getAttribute('aria-disabled') !== 'true') {
      showCaption(button.dataset.name, button);
    }
    if (action === 'play') {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (timeline.playing) stopPlayback();
      else startPlayback();
    } else if (action === 'speed') {
      timeline.speedIndex = (timeline.speedIndex + 1) % PLAYBACK_SPEEDS.length;
      renderTimelineUi();
    } else if (action === 'branch') {
      startFromHere();
    } else if (action === 'branches') {
      if (timeline.branchesOpen) closeBranches();
      else openBranches();
    } else if (action === 'reset') {
      resetTimeline();
    }
    if (action !== 'reset') disarmReset();
  }


  /* 18. caption and toast
     ------------------------------------------------------------------------
     the caption briefly names the button that was tapped. the toast is a
     brief, self-dismissing message used only for problems (export,
     autosave, history). neither blocks the editor.
     ======================================================================== */

  let toastTimer = null;
  let captionTimer = null;

  // briefly names the button that was tapped, right next to it: under a
  // toolbar button (beside the drop-down tab if the tab is there), beside
  // the tab's own button, or above the timeline
  function showCaption(text, anchor) {
    if (!text || !dom.caption || !anchor) return;
    const caption = dom.caption;
    caption.textContent = text;
    clearTimeout(caption._hideTimer);
    caption.hidden = false;

    const width = caption.offsetWidth;
    const height = caption.offsetHeight;
    const gap = 8;
    const margin = 8;
    const box = anchor.getBoundingClientRect();
    const tabOpen = mode !== 'idle';
    // where the tab is heading (it may still be sliding or growing)
    const bar = dom.tools.getBoundingClientRect();
    const tabRight = bar.right - (shape.center.target - TAB_WIDTH / 2);
    const tab = {
      left: tabRight - TAB_WIDTH,
      right: tabRight,
      top: bar.bottom,
      height: TAB_DEPTH,
    };
    let x;
    let y;
    // a caption lines up with an edge of the shape it comes from: the
    // timeline box, the tools panel, the 🤔 button. a button in the
    // left half of its shape uses the left edge, otherwise the right edge.
    const alignTo = (shape) => {
      const centre = box.left + box.width / 2;
      return centre < shape.left + shape.width / 2 ? shape.left : shape.right - width;
    };

    if (anchor === dom.dropButton) {
      x = tab.right + gap;
      y = tab.top + (tab.height - height) / 2;
    } else if (dom.timeline.contains(anchor)) {
      // above the whole timeline, never over its slider
      const shape = dom.timeline.getBoundingClientRect();
      x = alignTo(shape);
      y = shape.top - height - gap;
    } else if (dom.toolsBar.contains(anchor)) {
      // under the tools panel, flush with its right edge (where the panel
      // and the layers panel also line up); below the tab if it is in the way
      const shape = dom.tools.getBoundingClientRect();
      x = shape.right - width;
      y = shape.bottom + gap;
      if (tabOpen && x < tab.right + gap && x + width > tab.left - gap) y = tab.top + tab.height + gap;
    } else if (dom.cornerBar.contains(anchor)) {
      const shape = anchor.getBoundingClientRect();
      x = shape.left;
      y = shape.bottom + gap;
    } else if (box.top > viewportHeight / 2) {
      x = box.left + (box.width - width) / 2;
      y = box.top - height - gap;
    } else {
      x = box.left + (box.width - width) / 2;
      y = box.bottom + gap;
    }

    x = Math.min(Math.max(x, margin), viewportWidth - width - margin);
    caption.style.left = Math.round(x) + 'px';
    caption.style.top = Math.round(y) + 'px';
    showAnimated(caption);
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => hideAnimated(caption), 1200);
  }

  function showToast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    showAnimated(dom.toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hideAnimated(dom.toast), 3200);
  }


  /* 19. startup
     ======================================================================== */

  function queryDom() {
    const $ = (selector) => document.querySelector(selector);
    dom.workspace = $('.workspace');
    dom.stage = $('.stage');
    dom.canvasLabel = $('.canvas-label');
    dom.layers = $('.layers');
    dom.layersTool = $('[data-tool="layers"]');
    dom.layersList = $('.layers__list');
    dom.layersScroll = $('.layers__scroll');
    dom.layersCount = $('.layers__count');
    dom.layersIndicator = $('.layers__indicator');
    dom.layersClose = $('.layers__close');
    dom.canvasLabelText = $('.canvas-label__text');
    dom.cornerBar = $('.control-bar--help');
    dom.toolsBar = $('.control-bar--tools');
    dom.timelineBar = $('.control-bar--timeline');
    dom.tools = $('.tools');
    dom.toolsRow = $('.tools__row');
    dom.toolsAnchor = $('.tools__anchor');
    dom.deleteTool = $('[data-tool="delete"]');
    dom.undoTool = $('[data-tool="undo"]');
    dom.redoTool = $('[data-tool="redo"]');
    dom.exportTool = $('[data-tool="export"]');
    dom.addTool = $('[data-tool="add"]');
    dom.toolsDrop = $('.tools-drop');
    dom.toolsShape = $('.tools-shape');
    dom.toolsShapeGlass = $('.tools-shape__glass');
    dom.toolsShapePaths = [...document.querySelectorAll('.tools-shape svg path')];
    dom.dropButton = $('.tools-drop__button');
    dom.caption = $('.caption');
    dom.helpButton = $('.control-button--help');
    dom.help = $('.help');
    dom.helpClose = $('.help__close');
    dom.helpBody = $('.help__body');
    dom.timeline = $('.timeline');
    dom.timelineToggle = $('.timeline__toggle');
    dom.timelinePanel = $('.timeline__panel');
    dom.timelineStatus = $('.timeline__status');
    dom.timelineScrubber = $('.timeline__scrubber');
    dom.timelineTicks = $('.timeline__ticks');
    dom.timelineFill = $('.timeline__fill');
    dom.timelineKnob = $('.timeline__knob');
    dom.timelineControls = $('.timeline__controls');
    dom.resetButton = $('.timeline__reset');
    dom.playButton = $('[data-timeline="play"]');
    dom.speedButton = $('[data-timeline="speed"]');
    dom.branchHereButton = $('[data-timeline="branch"]');
    dom.branches = $('.branches');
    dom.branchesList = $('.branches__list');
    dom.branchesCount = $('.branches__count');
    dom.objectMenu = $('.object-menu');
    dom.menuButtons = [...document.querySelectorAll('.object-menu [data-menu]')];
    dom.menuRows = [...document.querySelectorAll('.object-menu__row')];
    dom.toast = $('.toast');
    dom.canvasPanel = $('.canvas-panel');
    dom.canvasSizeForm = $('.canvas-panel__size');
    dom.widthInput = $('.canvas-panel__size [name="width"]');
    dom.heightInput = $('.canvas-panel__size [name="height"]');
    dom.ratioGroup = $('.canvas-panel__ratios');
    dom.colorGroup = $('.canvas-panel__colors');
    dom.swatches = [...document.querySelectorAll('.canvas-panel__colors [data-color]')];
    dom.colorWheel = $('.swatch--wheel');
    dom.colorInput = $('.swatch__input');
    dom.ratioButtons = [...document.querySelectorAll('.canvas-panel__ratios [data-width]')];
    dom.picker = $('.picker');
    dom.pickerHeader = $('.picker__header');
    dom.pickerGrabber = $('.picker__grabber');
    dom.pickerSearch = $('.picker__search');
    dom.pickerCategories = $('.picker__categories');
    dom.pickerGrid = $('.picker__grid');
  }

  function bindEvents() {
    // stage
    dom.stage.addEventListener('pointerdown', onStagePointerDown);
    dom.stage.addEventListener('pointermove', onStagePointerMove);
    dom.stage.addEventListener('pointerup', onStagePointerEnd);
    dom.stage.addEventListener('pointercancel', onStagePointerEnd);
    dom.stage.addEventListener('wheel', onStageWheel, { passive: false });

    // tools
    dom.toolsAnchor.addEventListener('click', () => {
      closeObjectMenu();
      setToolsExpanded(dom.tools.dataset.expanded !== 'true');
    });
    dom.toolsRow.addEventListener('click', onToolClick);

    // tools drop-down and captions
    dom.dropButton.addEventListener('click', onDropClick);
    dom.helpButton.addEventListener('click', toggleHelp);
    dom.helpClose.addEventListener('click', () => closePanel());

    // object menu
    dom.objectMenu.addEventListener('click', onObjectMenuClick);

    // timeline
    dom.timelineToggle.addEventListener('click', () => {
      if (timeline.open) closeTimeline();
      else openTimeline();
      // the caption lines up with the timeline once it has finished opening
      // or closing (its edges move while it morphs)
      clearTimeout(captionTimer);
      captionTimer = setTimeout(() => showCaption(dom.timelineToggle.dataset.name, dom.timelineToggle),
        reducedMotion.matches ? 0 : PANEL_HIDE_DELAY);
    });
    dom.timelineControls.addEventListener('click', onTimelineControlClick);
    dom.branches.addEventListener('click', onBranchesClick);
    dom.branches.addEventListener('keydown', onBranchesKeyDown);
    setupScrubber();
    // the ticks follow the strip as it widens and narrows
    if (window.ResizeObserver) new ResizeObserver(() => drawTimelineTicks()).observe(dom.timelineScrubber);

    // canvas properties
    dom.canvasLabel.addEventListener('click', openCanvasPanel);

    // layers
    dom.layersClose.addEventListener('click', closeLayersPanel);
    dom.layersList.addEventListener('click', onLayersClick);
    dom.layersList.addEventListener('pointerdown', onLayerGripDown);
    dom.layersList.addEventListener('pointermove', onLayerGripMove);
    dom.layersList.addEventListener('pointerup', onLayerGripUp);
    dom.layersList.addEventListener('pointercancel', onLayerGripUp);
    dom.ratioGroup.addEventListener('click', onRatioClick);
    dom.colorGroup.addEventListener('click', onColorClick);
    dom.colorInput.addEventListener('input', onColorInput);
    dom.colorInput.addEventListener('change', onColorChange);
    dom.canvasSizeForm.addEventListener('submit', onCanvasSizeSubmit);

    // picker
    dom.pickerCategories.addEventListener('click', onPickerCategoryClick);
    dom.pickerGrid.addEventListener('click', onPickerGridClick);
    dom.pickerGrid.addEventListener('scroll', onPickerScroll, { passive: true });
    dom.pickerSearch.addEventListener('input', applyPickerSearch);
    setupPickerGrabber();

    // global
    document.addEventListener('keydown', onKeyDown);
    const onViewportChange = () => {
      resizeStage();
      updateToolsCover();
      if (timeline.open) drawTimelineTicks();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);
    // catches every change of the stage's own size, including ios toolbar changes
    if (window.ResizeObserver) new ResizeObserver(onViewportChange).observe(dom.stage);
    installGlobalGuards();
    installSaveTriggers();
  }

  function init() {
    queryDom();
    stageContext = dom.stage.getContext('2d');
    emojiFontFamily = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-family-emoji').trim() || 'sans-serif';

    restoreProject();

    setOpenPanel(null);
    document.body.dataset.timeline = 'closed';
    dom.timelinePanel.inert = true;
    setMode('idle');
    setToolsExpanded(false);
    // start at rest: no morph on page load
    Object.values(shape).forEach((s) => { s.value = s.target; s.velocity = 0; });
    drawToolsShape();
    updateHistoryButtons();
    updateClearButton();
    syncCanvasPanel();
    bindEvents();
    resizeStage();
    fitView();
    refreshClosedTimeline(false);

    // the label's height depends on the web font; refit once it has loaded
    // unless the user has already moved the view
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (view.scale === view.fitScale && !viewAnimation) fitView();
        else requestRender();
      });
    }
  }


  /* 20. emoji data
     ------------------------------------------------------------------------
     the catalog lives in js/emoji-data.js, loaded before this file.
     ======================================================================== */

  const EMOJI_CATEGORIES = Array.isArray(window.MOJI_EMOJI_CATEGORIES)
    ? window.MOJI_EMOJI_CATEGORIES
    : [];


  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
