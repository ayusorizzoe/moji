/* ==========================================================================
   moji: editor (0.0.1)

   structure
   1. configuration
   2. document model
   3. action history
   4. view (zoom and pan)
   5. emoji rendering
   6. stage rendering
   7. editing operations
   8. modes
   9. panels
   10. tools panel
   11. canvas properties
   12. emoji picker
   13. export
   14. stage input (tap, pinch, pan, wheel)
   15. keyboard and global guards
   16. autosave (local persistence)
   17. toast
   18. startup
   19. emoji data
   ========================================================================== */

(function () {
  'use strict';


  /* 1. configuration
     ======================================================================== */

  const DEFAULT_CANVAS = { width: 1080, height: 1920, background: '#FFFFFF' };
  const CANVAS_MIN_SIZE = 64;
  const CANVAS_MAX_SIZE = 4096;          // keeps exports within mobile canvas limits

  const DEFAULT_EMOJI_SIZE = 120;        // artwork px (font size of a placed emoji)
  const RENDER_STYLE_NATIVE = 'native';  // the platform's own color emoji font

  const GRID_WORLD_STEP = 120;           // artwork px between minor grid lines at base level
  const GRID_MIN_SCREEN_STEP = 24;       // screen px; grid steps are kept within [24, 120)
  const GRID_MAJOR_EVERY = 5;

  const TAP_SLOP = 8;                    // screen px a pointer may travel and still count as a tap
  const MIN_HIT_RADIUS = 22;             // screen px, so tiny emoji stay deletable by touch
  const ZOOM_MIN_FACTOR = 0.1;           // relative to the fit scale
  const ZOOM_MAX_FACTOR = 40;
  const PANEL_HIDE_DELAY = 400;          // ms; matches the css sheet/panel transitions
  const RECENTER_DURATION = 420;         // ms
  const WHEEL_ZOOM_SPEED = 0.0018;       // per wheel delta pixel
  const PINCH_ZOOM_SPEED = 0.01;         // per ctrl+wheel delta pixel (trackpad pinch)

  const STORAGE_KEY = 'moji.project';
  const STORAGE_BACKUP_KEY = 'moji.project.unrestored';
  const STORAGE_SCHEMA = 1;
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
       renderStyle  rendering style identifier ('native' in 0.0.1)
       x, y         center position in artwork coordinates
       size         font size in artwork px
       rotation     radians
       order        creation order (monotonic)
       createdAt    timestamp (ms)

     array order of doc.objects is the stacking order (last = topmost).
     ======================================================================== */

  const doc = {
    canvas: { ...DEFAULT_CANVAS },
    objects: [],
  };

  let nextOrder = 1;
  let idCounter = 0;

  function createId(prefix) {
    idCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) +
      '-' + Math.random().toString(36).slice(2, 6);
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


  /* 3. action history
     ------------------------------------------------------------------------
     every edit is recorded as a self-contained, immutable entry that holds
     enough data to apply and revert it. entries[0, cursor) are applied.
     a future timeline can read history.entries and replay them in order.
     ======================================================================== */

  const history = {
    entries: [],
    cursor: 0,
  };

  const operations = {
    'add-object': {
      apply(entry) {
        doc.objects.splice(entry.index, 0, { ...entry.object });
      },
      revert(entry) {
        const i = findObjectIndex(entry.object.id);
        if (i !== -1) doc.objects.splice(i, 1);
      },
    },
    'delete-object': {
      apply(entry) {
        const i = findObjectIndex(entry.object.id);
        if (i !== -1) doc.objects.splice(i, 1);
      },
      revert(entry) {
        doc.objects.splice(entry.index, 0, { ...entry.object });
      },
    },
    'resize-canvas': {
      apply(entry) {
        doc.canvas.width = entry.to.width;
        doc.canvas.height = entry.to.height;
      },
      revert(entry) {
        doc.canvas.width = entry.from.width;
        doc.canvas.height = entry.from.height;
      },
    },
  };

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  function commit(type, payload) {
    const entry = deepFreeze({ id: createId('act'), type, timestamp: Date.now(), ...payload });
    history.entries.length = history.cursor; // a new action discards the redo branch
    history.entries.push(entry);
    history.cursor += 1;
    operations[type].apply(entry);
    onDocumentChanged();
  }

  function canUndo() {
    return history.cursor > 0;
  }

  function canRedo() {
    return history.cursor < history.entries.length;
  }

  function undo() {
    if (!canUndo()) return;
    history.cursor -= 1;
    const entry = history.entries[history.cursor];
    operations[entry.type].revert(entry);
    onDocumentChanged();
  }

  function redo() {
    if (!canRedo()) return;
    const entry = history.entries[history.cursor];
    history.cursor += 1;
    operations[entry.type].apply(entry);
    onDocumentChanged();
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
    const { width, height } = doc.canvas;
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

  // the view that fits the whole canvas between the top and bottom controls
  function computeFitView() {
    // layout offsets (not bounding rects) so control animations never affect the fit
    const settings = dom.settingsBar;
    const tools = dom.toolsBar;
    const labelSpace = dom.canvasLabel.offsetHeight + 6;

    const left = settings.offsetLeft;
    const right = tools.offsetLeft + tools.offsetWidth;
    const top = Math.max(settings.offsetTop + settings.offsetHeight,
      tools.offsetTop + tools.offsetHeight) + 8 + labelSpace;
    const bottom = dom.timelineBar.offsetTop - 12;

    const availW = Math.max(1, right - left);
    const availH = Math.max(1, bottom - top);
    return {
      scale: Math.min(availW / doc.canvas.width, availH / doc.canvas.height),
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

  // draws one emoji object centered at (cx, cy) with a font size of px
  function drawEmoji(ctx, object, cx, cy, px) {
    if (px < 0.5) return;
    const metrics = getGlyphMetrics(object.emoji);
    ctx.save();
    ctx.translate(cx, cy);
    if (object.rotation) ctx.rotate(object.rotation);
    ctx.font = px + 'px ' + emojiFontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = metrics.baseline;
    ctx.fillStyle = '#000000';
    ctx.fillText(object.emoji, metrics.dx * px, metrics.dy * px);
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

  function resizeStage() {
    const previousWidth = viewportWidth;
    const previousHeight = viewportHeight;
    viewportWidth = dom.stage.clientWidth;
    viewportHeight = dom.stage.clientHeight;
    pixelRatio = window.devicePixelRatio || 1;
    dom.stage.width = Math.round(viewportWidth * pixelRatio);
    dom.stage.height = Math.round(viewportHeight * pixelRatio);

    // keep the artwork centered where it was when the viewport changes
    if (previousWidth) {
      view.tx += (viewportWidth - previousWidth) / 2;
      view.ty += (viewportHeight - previousHeight) / 2;
    }
    requestRender();
  }

  function render() {
    renderQueued = false;
    const ctx = stageContext;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dom.stage.width, dom.stage.height);
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    // canvas surface, edges snapped to device pixels for a crisp boundary
    const rect = canvasScreenRect();
    const snap = (v) => Math.round(v * pixelRatio) / pixelRatio;
    const x0 = snap(rect.x);
    const y0 = snap(rect.y);
    ctx.fillStyle = doc.canvas.background;
    ctx.fillRect(x0, y0, snap(rect.x + rect.w) - x0, snap(rect.y + rect.h) - y0);

    // objects, inside and outside the canvas, in stacking order
    const scale = view.scale;
    for (const object of doc.objects) {
      const px = object.size * scale;
      const sx = object.x * scale + view.tx;
      const sy = object.y * scale + view.ty;
      if (sx + px < 0 || sx - px > viewportWidth || sy + px < 0 || sy - px > viewportHeight) continue;
      drawEmoji(ctx, object, sx, sy, px);
    }

    updateGrid();
    positionCanvasLabel(rect);
    if (openPanel === 'canvas') positionCanvasPanel();
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

  function positionCanvasLabel(rect) {
    const x = Math.round(rect.x);
    const y = Math.round(rect.y - dom.canvasLabel.offsetHeight - 6);
    dom.canvasLabel.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }


  /* 7. editing operations
     ======================================================================== */

  function placeEmoji(emoji, worldX, worldY) {
    const object = createEmojiObject(emoji, worldX, worldY);
    commit('add-object', { object, index: doc.objects.length });
  }

  // topmost object under a screen point, or null
  function hitTest(sx, sy) {
    const point = screenToWorld(sx, sy);
    const minHalf = MIN_HIT_RADIUS / view.scale;
    for (let i = doc.objects.length - 1; i >= 0; i -= 1) {
      const object = doc.objects[i];
      let dx = point.x - object.x;
      let dy = point.y - object.y;
      if (object.rotation) {
        const cos = Math.cos(-object.rotation);
        const sin = Math.sin(-object.rotation);
        const rx = dx * cos - dy * sin;
        dy = dx * sin + dy * cos;
        dx = rx;
      }
      const half = Math.max(object.size / 2, minHalf);
      if (Math.abs(dx) <= half && Math.abs(dy) <= half) return object;
    }
    return null;
  }

  function deleteObject(object) {
    const index = findObjectIndex(object.id);
    if (index === -1) return;
    commit('delete-object', { object: { ...object }, index });
  }

  function resizeCanvas(width, height) {
    const from = { width: doc.canvas.width, height: doc.canvas.height };
    if (from.width === width && from.height === height) return;
    commit('resize-canvas', { from, to: { width, height } });
  }

  function onDocumentChanged() {
    updateHistoryButtons();
    syncCanvasPanel();
    requestRender();
    scheduleSave();
  }


  /* 8. modes
     ------------------------------------------------------------------------
     idle: taps do nothing. place: each tap places the current material.
     delete: each tap removes the topmost emoji under the pointer.
     ======================================================================== */

  let mode = 'idle';
  let material = null;

  function setMode(next) {
    mode = next;
    document.body.dataset.mode = next;
    dom.deleteTool.setAttribute('aria-pressed', String(next === 'delete'));
    dom.modeBar.hidden = next === 'idle';
    dom.exitModeButton.setAttribute('aria-label',
      next === 'delete' ? 'exit delete mode' : 'exit placement mode');
    if (next !== 'place') material = null;
  }

  function selectMaterial(emoji) {
    closePanel();
    setMode('place');
    material = emoji;
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
    } else if (closing === 'canvas') {
      hideAnimated(dom.canvasPanel);
      dom.canvasLabel.setAttribute('aria-expanded', 'false');
    }
    return true;
  }


  /* 10. tools panel
     ======================================================================== */

  function setToolsExpanded(expanded) {
    dom.tools.dataset.expanded = String(expanded);
    dom.toolsAnchor.setAttribute('aria-expanded', String(expanded));
    dom.toolsRow.inert = !expanded;
    updateToolsCover();
  }

  // on narrow screens the expanded tools reach the settings corner; settings
  // then fades aside (it never moves) until the tools collapse again
  function updateToolsCover() {
    let cover = false;
    if (dom.tools.dataset.expanded === 'true') {
      const toolsRight = dom.toolsBar.getBoundingClientRect().right;
      const expandedWidth = dom.toolsAnchor.offsetWidth + dom.toolsRow.offsetWidth;
      const settingsRight = dom.settingsBar.getBoundingClientRect().right;
      cover = toolsRight - expandedWidth < settingsRight + 8;
    }
    document.body.dataset.toolsCover = String(cover);
  }

  function updateHistoryButtons() {
    dom.undoTool.setAttribute('aria-disabled', String(!canUndo()));
    dom.redoTool.setAttribute('aria-disabled', String(!canRedo()));
  }

  function onToolClick(event) {
    const button = event.target.closest('[data-tool]');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;

    switch (button.dataset.tool) {
      case 'add':
        setToolsExpanded(false);
        openPicker();
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
      case 'recenter':
        recenterView();
        break;
      case 'export':
        exportPng();
        break;
      default:
        break;
    }
  }


  /* 11. canvas properties
     ======================================================================== */

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

  function syncCanvasPanel() {
    const { width, height } = doc.canvas;
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
     touch: one finger taps (place / delete); two fingers pinch-zoom and pan.
     desktop: click acts; drag (left or middle button) pans; the scroll wheel
     and trackpad scrolling zoom around the pointer; trackpad pinch zooms.
     a gesture that moves, or that ever uses two pointers, never counts as
     a tap.

     browsers do not reveal whether wheel input comes from a mouse or a
     trackpad, so wheel input is not guessed at: every wheel event zooms.
     ======================================================================== */

  const pointers = new Map();
  let gesture = null;

  function pointerPair() {
    const [a, b] = [...pointers.values()];
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  function onStagePointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return;
    try { dom.stage.setPointerCapture(event.pointerId); } catch (e) { /* synthetic pointer */ }

    cancelViewAnimation();
    const closedPanel = closePanel();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      gesture = {
        startX: event.clientX,
        startY: event.clientY,
        tap: !closedPanel && event.button === 0,
        mouse: event.pointerType === 'mouse',
        pair: null,
      };
    } else if (gesture) {
      gesture.tap = false;
      gesture.pair = pointerPair();
    }
  }

  function onStagePointerMove(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer || !gesture) return;
    const lastX = pointer.x;
    const lastY = pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (pointers.size === 1) {
      const travelled = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (travelled > TAP_SLOP) gesture.tap = false;
      if (gesture.mouse && !gesture.tap) panBy(event.clientX - lastX, event.clientY - lastY);
      return;
    }

    // two (or more) pointers: zoom around the previous midpoint, then follow it
    const pair = pointerPair();
    const previous = gesture.pair || pair;
    if (previous.distance > 0) zoomAt(previous.midX, previous.midY, pair.distance / previous.distance);
    panBy(pair.midX - previous.midX, pair.midY - previous.midY);
    gesture.pair = pair;
  }

  function onStagePointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);

    if (pointers.size === 0) {
      if (gesture && gesture.tap && event.type === 'pointerup') handleTap(event.clientX, event.clientY);
      gesture = null;
    } else if (gesture) {
      gesture.pair = pointers.size >= 2 ? pointerPair() : null;
    }
  }

  function handleTap(sx, sy) {
    if (mode === 'place' && material) {
      const point = screenToWorld(sx, sy);
      placeEmoji(material, point.x, point.y);
    } else if (mode === 'delete') {
      const hit = hitTest(sx, sy);
      if (hit) deleteObject(hit);
    }
  }

  function onStageWheel(event) {
    event.preventDefault();
    cancelViewAnimation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
    // purely horizontal scrolling has no zoom meaning; ignore it
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : 0) * unit;
    if (!delta) return;

    if (event.ctrlKey || event.metaKey) {
      // trackpad pinch (browsers report it as ctrl + wheel), or ctrl/⌘ + wheel
      const step = Math.max(-60, Math.min(60, delta));
      zoomAt(event.clientX, event.clientY, Math.exp(-step * PINCH_ZOOM_SPEED));
    } else {
      // mouse wheel or trackpad scroll: one consistent behavior, zoom
      const step = Math.max(-120, Math.min(120, delta));
      zoomAt(event.clientX, event.clientY, Math.exp(-step * WHEEL_ZOOM_SPEED));
    }
  }


  /* 15. keyboard and global guards
     ======================================================================== */

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (closePanel()) return;
    if (mode !== 'idle') {
      setMode('idle');
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
    // a ctrl+wheel (trackpad pinch) over the interface must never zoom the page
    window.addEventListener('wheel', (event) => {
      if (event.ctrlKey) event.preventDefault();
    }, { passive: false });
  }


  /* 16. autosave (local persistence)
     ------------------------------------------------------------------------
     the structured project (canvas, objects, action history) is saved to
     localStorage a moment after each change and whenever the page is
     hidden. on startup a saved project is validated and restored without
     creating history entries.

     if a saved project cannot be restored, its raw data is copied to a
     backup key before anything new is saved, so it is never silently lost.
     if no backup can be made, autosave stays off for the session.

     local browser storage is not a backup: browsers or users may clear it.
     ======================================================================== */

  let storage = null;
  let saveTimer = null;
  let saveNeeded = false;
  let historySaveWarned = false;

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

  function serializeProject(includeHistory) {
    return JSON.stringify({
      app: 'moji',
      schema: STORAGE_SCHEMA,
      savedAt: Date.now(),
      canvas: { ...doc.canvas },
      objects: doc.objects,
      history: includeHistory
        ? { entries: history.entries, cursor: history.cursor }
        : { entries: [], cursor: 0 },
    });
  }

  function scheduleSave() {
    if (!storage) return;
    saveNeeded = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!storage || !saveNeeded) return;
    saveNeeded = false;
    try {
      storage.setItem(STORAGE_KEY, serializeProject(true));
    } catch (error) {
      // most likely the storage quota: keep the artwork, drop the history
      try {
        storage.setItem(STORAGE_KEY, serializeProject(false));
        if (!historySaveWarned) {
          historySaveWarned = true;
          showToast('storage is full: artwork saved without undo history');
        }
      } catch (secondError) {
        showToast('autosave failed: browser storage is full or unavailable');
      }
    }
  }

  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

  function isValidDimensions(d) {
    return d && Number.isInteger(d.width) && Number.isInteger(d.height) &&
      d.width >= CANVAS_MIN_SIZE && d.width <= CANVAS_MAX_SIZE &&
      d.height >= CANVAS_MIN_SIZE && d.height <= CANVAS_MAX_SIZE;
  }

  function isValidObject(o) {
    return o && typeof o.id === 'string' && o.type === 'emoji' &&
      typeof o.emoji === 'string' && o.emoji.length > 0 &&
      typeof o.renderStyle === 'string' &&
      isFiniteNumber(o.x) && isFiniteNumber(o.y) &&
      isFiniteNumber(o.size) && o.size > 0 &&
      isFiniteNumber(o.rotation) && isFiniteNumber(o.order);
  }

  function isValidEntry(e) {
    if (!e || typeof e.id !== 'string' || !operations[e.type]) return false;
    if (e.type === 'add-object' || e.type === 'delete-object') {
      return isValidObject(e.object) && Number.isInteger(e.index) && e.index >= 0;
    }
    if (e.type === 'resize-canvas') return isValidDimensions(e.from) && isValidDimensions(e.to);
    return false;
  }

  // returns a clean project or throws if the artwork itself is unusable
  function parseProject(raw) {
    const data = JSON.parse(raw);
    if (!data || data.app !== 'moji' || data.schema !== STORAGE_SCHEMA) {
      throw new Error('unrecognized project format');
    }
    if (!isValidDimensions(data.canvas) || !Array.isArray(data.objects) ||
        !data.objects.every(isValidObject)) {
      throw new Error('invalid artwork data');
    }
    const background = /^#[0-9a-f]{6}$/i.test(data.canvas.background || '')
      ? data.canvas.background : DEFAULT_CANVAS.background;

    // history is optional: if it is damaged, keep the artwork and start fresh
    let entries = [];
    let cursor = 0;
    const h = data.history;
    if (h && Array.isArray(h.entries) && h.entries.every(isValidEntry) &&
        Number.isInteger(h.cursor) && h.cursor >= 0 && h.cursor <= h.entries.length) {
      entries = h.entries;
      cursor = h.cursor;
    }

    return {
      canvas: { width: data.canvas.width, height: data.canvas.height, background },
      objects: data.objects.map((o) => ({ ...o })),
      entries,
      cursor,
    };
  }

  function restoreProject() {
    storage = openStorage();
    if (!storage) {
      showToast('autosave is unavailable in this browser');
      return;
    }

    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (error) {
      storage = null;
      return;
    }
    if (!raw) return;

    let project;
    try {
      project = parseProject(raw);
    } catch (error) {
      // keep the unreadable data before any new save can replace it
      try {
        storage.setItem(STORAGE_BACKUP_KEY, raw);
        showToast('the saved project could not be opened; a copy was kept');
      } catch (backupError) {
        storage = null;
        showToast('the saved project could not be opened; autosave is paused');
      }
      return;
    }

    doc.canvas = project.canvas;
    doc.objects = project.objects;
    history.entries = project.entries.map(deepFreeze);
    history.cursor = project.cursor;

    // continue creation order after everything that exists or may be redone
    let maxOrder = 0;
    doc.objects.forEach((o) => { maxOrder = Math.max(maxOrder, o.order); });
    history.entries.forEach((e) => {
      if (e.object) maxOrder = Math.max(maxOrder, e.object.order);
    });
    nextOrder = maxOrder + 1;
  }

  function installSaveTriggers() {
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }


  /* 17. toast
     ------------------------------------------------------------------------
     a brief, self-dismissing message used only for problems (export or
     autosave). it never blocks the editor.
     ======================================================================== */

  let toastTimer = null;

  function showToast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    showAnimated(dom.toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hideAnimated(dom.toast), 3200);
  }


  /* 18. startup
     ======================================================================== */

  function queryDom() {
    const $ = (selector) => document.querySelector(selector);
    dom.workspace = $('.workspace');
    dom.stage = $('.stage');
    dom.canvasLabel = $('.canvas-label');
    dom.settingsBar = $('.control-bar--settings');
    dom.toolsBar = $('.control-bar--tools');
    dom.timelineBar = $('.control-bar--timeline');
    dom.tools = $('.tools');
    dom.toolsRow = $('.tools__row');
    dom.toolsAnchor = $('.tools__anchor');
    dom.deleteTool = $('[data-tool="delete"]');
    dom.undoTool = $('[data-tool="undo"]');
    dom.redoTool = $('[data-tool="redo"]');
    dom.exportTool = $('[data-tool="export"]');
    dom.modeBar = $('.control-bar--mode');
    dom.exitModeButton = $('[data-action="exit-mode"]');
    dom.reopenPickerButton = $('[data-action="reopen-picker"]');
    dom.toast = $('.toast');
    dom.canvasPanel = $('.canvas-panel');
    dom.canvasSizeForm = $('.canvas-panel__size');
    dom.widthInput = $('.canvas-panel__size [name="width"]');
    dom.heightInput = $('.canvas-panel__size [name="height"]');
    dom.ratioGroup = $('.canvas-panel__ratios');
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
      setToolsExpanded(dom.tools.dataset.expanded !== 'true');
    });
    dom.toolsRow.addEventListener('click', onToolClick);

    // mode bar
    dom.reopenPickerButton.addEventListener('click', openPicker);
    dom.exitModeButton.addEventListener('click', () => setMode('idle'));

    // canvas properties
    dom.canvasLabel.addEventListener('click', openCanvasPanel);
    dom.ratioGroup.addEventListener('click', onRatioClick);
    dom.canvasSizeForm.addEventListener('submit', onCanvasSizeSubmit);

    // picker
    dom.pickerCategories.addEventListener('click', onPickerCategoryClick);
    dom.pickerGrid.addEventListener('click', onPickerGridClick);
    dom.pickerGrid.addEventListener('scroll', onPickerScroll, { passive: true });
    dom.pickerSearch.addEventListener('input', applyPickerSearch);
    setupPickerGrabber();

    // global
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', () => {
      resizeStage();
      updateToolsCover();
    });
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
    setMode('idle');
    setToolsExpanded(false);
    updateHistoryButtons();
    syncCanvasPanel();
    bindEvents();
    resizeStage();
    fitView();

    // the label's height depends on the web font; refit once it has loaded
    // unless the user has already moved the view
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (view.scale === view.fitScale && !viewAnimation) fitView();
        else requestRender();
      });
    }
  }


  /* 19. emoji data
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
