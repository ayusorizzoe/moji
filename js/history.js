/* ==========================================================================
   moji: history engine (0.0.2)

   pure data and logic, no dom. js/main.js uses it through window.MojiHistory.

   model
   - artwork state: { canvas, objects }. objects are never mutated: every
     operation builds new objects and new arrays, so a past state can be kept
     by reference and snapshots are cheap.
   - an operation (op) is a self-contained record of one meaningful edit with
     enough data to apply it, revert it, and animate it.
   - a branch is an ordered log of events. each event is one of
       { type: 'op', op }   a new edit
       { type: 'undo' }     undo the most recent applied op
       { type: 'redo' }     redo the most recently undone op
     undo and redo are kept as events, so the creative process (mistakes and
     corrections included) stays visible in the timeline.
   - the artwork and its undo/redo stacks at any moment are rebuilt by
     replaying events from the project's base state. snapshots (checkpoints)
     every CHECKPOINT_EVERY events keep scrubbing fast; they live in memory
     only and are never saved.
   - branches: the root branch starts at the project base. every other branch
     starts at (parentId, parentIndex): the state after its parent's first
     parentIndex events (its parent's own chronology). shared history is not
     copied. a branch's chronology = its ancestors' events up to each branch
     point, followed by its own events.
   ========================================================================== */

(function () {
  'use strict';

  const SCHEMA = 2;
  const CHECKPOINT_EVERY = 32;
  const MAX_BRANCHES = 5;
  const CANVAS_MIN_SIZE = 64;
  const CANVAS_MAX_SIZE = 4096;


  /* 1. helpers
     ======================================================================== */

  let idCounter = 0;
  function createId(prefix) {
    idCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) +
      '-' + Math.random().toString(36).slice(2, 6);
  }

  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  function cloneState(state) {
    return {
      canvas: state.canvas,
      objects: state.objects,
      undo: state.undo ? state.undo.slice() : [],
      redo: state.redo ? state.redo.slice() : [],
    };
  }

  function withoutIds(objects, ids) {
    return objects.filter((o) => !ids.has(o.id));
  }

  function orderBy(objects, ids) {
    const byId = new Map(objects.map((o) => [o.id, o]));
    const ordered = [];
    ids.forEach((id) => {
      const o = byId.get(id);
      if (o) {
        ordered.push(o);
        byId.delete(id);
      }
    });
    // anything not mentioned keeps its place at the end (should not happen)
    byId.forEach((o) => ordered.push(o));
    return ordered;
  }


  /* 2. operations
     ------------------------------------------------------------------------
     apply(state, op) and revert(state, op) replace state.canvas and
     state.objects with new values; they never mutate existing objects.
     the 0.0.1 types (add-object, delete-object, clear-objects,
     resize-canvas) are kept so older projects replay unchanged.
     ======================================================================== */

  function insertAt(objects, entries) {
    // entries: [{ object, index }] with indices in the final array
    const next = objects.slice();
    entries.slice().sort((a, b) => a.index - b.index).forEach(({ object, index }) => {
      next.splice(Math.min(index, next.length), 0, object);
    });
    return next;
  }

  const operations = {
    'add-object': {
      apply(st, op) { st.objects = insertAt(st.objects, [{ object: op.object, index: op.index }]); },
      revert(st, op) { st.objects = withoutIds(st.objects, new Set([op.object.id])); },
    },
    'delete-object': {
      apply(st, op) { st.objects = withoutIds(st.objects, new Set([op.object.id])); },
      revert(st, op) { st.objects = insertAt(st.objects, [{ object: op.object, index: op.index }]); },
    },
    'add-objects': {
      apply(st, op) {
        st.objects = insertAt(st.objects, op.objects.map((object, i) => ({ object, index: op.indices[i] })));
      },
      revert(st, op) { st.objects = withoutIds(st.objects, new Set(op.objects.map((o) => o.id))); },
    },
    'delete-objects': {
      apply(st, op) { st.objects = withoutIds(st.objects, new Set(op.objects.map((o) => o.id))); },
      revert(st, op) {
        st.objects = insertAt(st.objects, op.objects.map((object, i) => ({ object, index: op.indices[i] })));
      },
    },
    'clear-objects': {
      apply(st) { st.objects = []; },
      revert(st, op) { st.objects = op.objects.slice(); },
    },
    'resize-canvas': {
      apply(st, op) { st.canvas = { ...st.canvas, width: op.to.width, height: op.to.height }; },
      revert(st, op) { st.canvas = { ...st.canvas, width: op.from.width, height: op.from.height }; },
    },
    // canvas background color: from/to are '#rrggbb'
    'set-background': {
      apply(st, op) { st.canvas = { ...st.canvas, background: op.to }; },
      revert(st, op) { st.canvas = { ...st.canvas, background: op.from }; },
    },
    // move, resize, rotate (one completed gesture, any number of objects)
    'transform-objects': {
      apply(st, op) { st.objects = setFields(st.objects, op.changes, 'to'); },
      revert(st, op) { st.objects = setFields(st.objects, op.changes, 'from'); },
    },
    // group and ungroup: changes = [{ id, from: groupId|null, to: groupId|null }]
    'set-groups': {
      apply(st, op) { st.objects = setGroups(st.objects, op.changes, 'to'); },
      revert(st, op) { st.objects = setGroups(st.objects, op.changes, 'from'); },
    },
    // stacking order: from/to are full id orders (bottom to top)
    'reorder': {
      apply(st, op) { st.objects = orderBy(st.objects, op.to); },
      revert(st, op) { st.objects = orderBy(st.objects, op.from); },
    },
    // layers panel drags and grouping: a new stacking order (full id lists,
    // bottom to top) together with any group membership changes, as one step.
    // groups are flat (an emoji belongs to at most one group) and every
    // transform is absolute, so changing membership never moves anything.
    'arrange': {
      apply(st, op) { st.objects = setGroups(orderBy(st.objects, op.to), op.groups, 'to'); },
      revert(st, op) { st.objects = setGroups(orderBy(st.objects, op.from), op.groups, 'from'); },
    },
    // visibility and locking: changes = [{ id, from: { hidden, locked }, to }]
    'set-flags': {
      apply(st, op) { st.objects = setFlags(st.objects, op.changes, 'to'); },
      revert(st, op) { st.objects = setFlags(st.objects, op.changes, 'from'); },
    },
  };

  function setFlags(objects, changes, side) {
    const byId = new Map(changes.map((c) => [c.id, c[side]]));
    return objects.map((o) => {
      const f = byId.get(o.id);
      if (!f) return o;
      const next = { ...o };
      ['hidden', 'locked'].forEach((key) => {
        if (f[key]) next[key] = true;
        else delete next[key];
      });
      return next;
    });
  }

  function setFields(objects, changes, side) {
    const byId = new Map(changes.map((c) => [c.id, c[side]]));
    return objects.map((o) => {
      const t = byId.get(o.id);
      return t ? { ...o, x: t.x, y: t.y, size: t.size, rotation: t.rotation } : o;
    });
  }

  function setGroups(objects, changes, side) {
    const byId = new Map(changes.map((c) => [c.id, c[side]]));
    return objects.map((o) => {
      if (!byId.has(o.id)) return o;
      const groupId = byId.get(o.id);
      const next = { ...o };
      if (groupId) next.groupId = groupId;
      else delete next.groupId;
      return next;
    });
  }

  // advance a state by one event (mutates state; returns what happened)
  function step(state, event) {
    if (event.type === 'op') {
      operations[event.op.type].apply(state, event.op);
      state.undo.push(event.op);
      state.redo.length = 0;
      return { op: event.op, direction: 1 };
    }
    if (event.type === 'undo') {
      const op = state.undo.pop();
      if (!op) return null;
      operations[op.type].revert(state, op);
      state.redo.push(op);
      return { op, direction: -1 };
    }
    if (event.type === 'redo') {
      const op = state.redo.pop();
      if (!op) return null;
      operations[op.type].apply(state, op);
      state.undo.push(op);
      return { op, direction: 1 };
    }
    return null;
  }


  /* 3. project and branches
     ======================================================================== */

  function createProject(base) {
    const root = {
      id: createId('branch'),
      name: 'original',
      parentId: null,
      parentIndex: 0,
      createdAt: Date.now(),
      events: [],
    };
    return {
      base: { canvas: { ...base.canvas }, objects: base.objects.slice() },
      branches: [root],
      activeId: root.id,
      nextBranchNumber: 1,
      cache: new Map(), // branchId -> { flat, checkpoints } (memory only)
    };
  }

  function getBranch(project, id) {
    return project.branches.find((b) => b.id === id) || null;
  }

  // root → branch: [{ branch, count }] where count is how many of that
  // branch's events belong to this chronology
  function chain(project, branchId) {
    const segments = [];
    let branch = getBranch(project, branchId);
    let count = branch ? branch.events.length : 0;
    while (branch) {
      segments.unshift({ branch, count });
      const parent = branch.parentId ? getBranch(project, branch.parentId) : null;
      count = branch.parentIndex;
      branch = parent;
    }
    return segments;
  }

  function cacheFor(project, branchId) {
    let entry = project.cache.get(branchId);
    if (!entry) {
      const flat = [];
      chain(project, branchId).forEach(({ branch, count }) => {
        for (let i = 0; i < count; i += 1) flat.push(branch.events[i]);
      });
      entry = { flat, checkpoints: new Map() };
      project.cache.set(branchId, entry);
    }
    return entry;
  }

  function chronology(project, branchId) {
    return cacheFor(project, branchId).flat;
  }

  // indices in the chronology where the branch left each ancestor
  function branchPoints(project, branchId) {
    const points = [];
    let total = 0;
    const segments = chain(project, branchId);
    segments.forEach((segment, i) => {
      total += segment.count;
      if (i < segments.length - 1) points.push(total);
    });
    return points;
  }

  function baseState(project) {
    return { canvas: project.base.canvas, objects: project.base.objects, undo: [], redo: [] };
  }

  // artwork and undo/redo stacks after the first k events of a branch
  function stateAt(project, branchId, k) {
    const entry = cacheFor(project, branchId);
    const flat = entry.flat;
    const target = Math.max(0, Math.min(k, flat.length));

    let from = 0;
    let state = null;
    for (let c = Math.floor(target / CHECKPOINT_EVERY) * CHECKPOINT_EVERY; c > 0; c -= CHECKPOINT_EVERY) {
      if (entry.checkpoints.has(c)) {
        from = c;
        state = cloneState(entry.checkpoints.get(c));
        break;
      }
    }
    if (!state) state = baseState(project);

    for (let i = from; i < target; i += 1) {
      step(state, flat[i]);
      const reached = i + 1;
      if (reached % CHECKPOINT_EVERY === 0 && !entry.checkpoints.has(reached)) {
        entry.checkpoints.set(reached, cloneState(state));
      }
    }
    return cloneState(state);
  }

  function latestState(project, branchId) {
    return stateAt(project, branchId, chronology(project, branchId).length);
  }

  // record a new event on a branch; the cached chronology grows in place
  function append(project, branchId, event) {
    const branch = getBranch(project, branchId);
    deepFreeze(event);
    branch.events.push(event);
    const entry = project.cache.get(branchId);
    if (entry) entry.flat.push(event);
  }

  function makeEvent(type, op) {
    const event = { id: createId('evt'), type, at: Date.now() };
    if (op) event.op = op;
    return event;
  }

  // the branch and local index that position k of a chronology belongs to
  function locate(project, branchId, k) {
    let remaining = k;
    const segments = chain(project, branchId);
    for (let i = 0; i < segments.length; i += 1) {
      const { branch, count } = segments[i];
      if (remaining <= count) return { branch, index: remaining };
      remaining -= count;
    }
    const last = segments[segments.length - 1];
    return { branch: last.branch, index: last.count };
  }

  function canCreateBranch(project) {
    return project.branches.length < MAX_BRANCHES;
  }

  // a new branch that starts at position k of an existing branch's chronology
  function createBranch(project, fromBranchId, k) {
    if (!canCreateBranch(project)) return null;
    const { branch: parent, index } = locate(project, fromBranchId, k);
    const branch = {
      id: createId('branch'),
      name: 'branch ' + project.nextBranchNumber,
      parentId: parent.id,
      parentIndex: index,
      createdAt: Date.now(),
      events: [],
    };
    project.nextBranchNumber += 1;
    project.branches.push(branch);
    return branch;
  }

  function renameBranch(project, branchId, name) {
    const branch = getBranch(project, branchId);
    const clean = String(name || '').trim().slice(0, 40);
    if (branch && clean) branch.name = clean;
    return branch;
  }

  // delete a branch. children that started from it take over the shared part
  // of its history, so they keep exactly the same chronology.
  function deleteBranch(project, branchId) {
    if (project.branches.length <= 1 || branchId === project.activeId) return false;
    const doomed = getBranch(project, branchId);
    if (!doomed) return false;
    project.branches.forEach((child) => {
      if (child.parentId !== doomed.id) return;
      child.events = doomed.events.slice(0, child.parentIndex).concat(child.events);
      child.parentId = doomed.parentId;
      child.parentIndex = doomed.parentId ? doomed.parentIndex : 0;
    });
    project.branches = project.branches.filter((b) => b.id !== doomed.id);
    project.cache.clear();
    return true;
  }


  /* 4. playback transitions
     ------------------------------------------------------------------------
     a transition compares the artwork before and after one event and lists
     only what changed: objects that appear, disappear, or move, resize or
     rotate. playback interpolates just those; everything else stays still.
     ======================================================================== */

  function makeTransition(before, after) {
    const beforeById = new Map(before.objects.map((o, i) => [o.id, { o, i }]));
    const afterIds = new Set(after.objects.map((o) => o.id));
    const entries = after.objects.map((o) => {
      const prev = beforeById.get(o.id);
      if (!prev) return { kind: 'in', object: o };
      const p = prev.o;
      if (p.x !== o.x || p.y !== o.y || p.size !== o.size || p.rotation !== o.rotation) {
        return { kind: 'move', from: p, object: o };
      }
      return { kind: 'same', object: o };
    });
    // disappearing objects keep (roughly) their old place in the stack
    before.objects.forEach((o, i) => {
      if (afterIds.has(o.id)) return;
      entries.splice(Math.min(i, entries.length), 0, { kind: 'out', object: o });
    });
    const canvasChanged = before.canvas.width !== after.canvas.width ||
      before.canvas.height !== after.canvas.height ||
      before.canvas.background !== after.canvas.background;
    const visible = canvasChanged || entries.some((e) => e.kind !== 'same') ||
      before.objects.some((o, i) => after.objects[i] !== o);
    return { entries, from: before.canvas, to: after.canvas, canvasChanged, visible };
  }

  // blends two '#rrggbb' colors (t = 0 → a, 1 → b)
  function mixColor(a, b, t) {
    if (a === b || !isColor(a) || !isColor(b)) return t < 0.5 ? a : b;
    const ca = parseInt(a.slice(1), 16);
    const cb = parseInt(b.slice(1), 16);
    let out = '#';
    for (let shift = 16; shift >= 0; shift -= 8) {
      const x = (ca >> shift) & 255;
      const y = (cb >> shift) & 255;
      out += Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    }
    return out;
  }

  function isColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  }

  function sceneAt(transition, t) {
    const e = t;
    const objects = transition.entries.map((entry) => {
      const o = entry.object;
      if (entry.kind === 'same') return o;
      if (entry.kind === 'in') return { ...o, alpha: e, size: o.size * (0.55 + 0.45 * e) };
      if (entry.kind === 'out') return { ...o, alpha: 1 - e, size: o.size * (1 - 0.25 * e) };
      const f = entry.from;
      return {
        ...o,
        x: f.x + (o.x - f.x) * e,
        y: f.y + (o.y - f.y) * e,
        size: f.size + (o.size - f.size) * e,
        rotation: f.rotation + (o.rotation - f.rotation) * e,
      };
    });
    const canvas = transition.canvasChanged
      ? {
        ...transition.to,
        width: transition.from.width + (transition.to.width - transition.from.width) * e,
        height: transition.from.height + (transition.to.height - transition.from.height) * e,
        background: mixColor(transition.from.background, transition.to.background, e),
      }
      : transition.to;
    return { canvas, objects };
  }


  /* 5. validation, serialization and migration
     ======================================================================== */

  function isValidDimensions(d) {
    return !!d && Number.isInteger(d.width) && Number.isInteger(d.height) &&
      d.width >= CANVAS_MIN_SIZE && d.width <= CANVAS_MAX_SIZE &&
      d.height >= CANVAS_MIN_SIZE && d.height <= CANVAS_MAX_SIZE;
  }

  function isValidObject(o) {
    return !!o && typeof o.id === 'string' && o.type === 'emoji' &&
      typeof o.emoji === 'string' && o.emoji.length > 0 &&
      typeof o.renderStyle === 'string' &&
      isFiniteNumber(o.x) && isFiniteNumber(o.y) &&
      isFiniteNumber(o.size) && o.size > 0 &&
      isFiniteNumber(o.rotation) && isFiniteNumber(o.order) &&
      (o.groupId === undefined || typeof o.groupId === 'string') &&
      (o.hidden === undefined || typeof o.hidden === 'boolean') &&
      (o.locked === undefined || typeof o.locked === 'boolean');
  }

  function isValidTransform(t) {
    return !!t && isFiniteNumber(t.x) && isFiniteNumber(t.y) &&
      isFiniteNumber(t.size) && t.size > 0 && isFiniteNumber(t.rotation);
  }

  const isIndex = (i) => Number.isInteger(i) && i >= 0;
  const isGroupChange = (c) => !!c && typeof c.id === 'string' &&
    (c.from === null || typeof c.from === 'string') && (c.to === null || typeof c.to === 'string');
  const isFlags = (f) => !!f && typeof f.hidden === 'boolean' && typeof f.locked === 'boolean';
  const isIdList = (list) => Array.isArray(list) && list.every((id) => typeof id === 'string');

  function isValidOp(op) {
    if (!op || !operations[op.type]) return false;
    switch (op.type) {
      case 'add-object':
      case 'delete-object':
        return isValidObject(op.object) && isIndex(op.index);
      case 'add-objects':
      case 'delete-objects':
        return Array.isArray(op.objects) && op.objects.every(isValidObject) &&
          Array.isArray(op.indices) && op.indices.length === op.objects.length && op.indices.every(isIndex);
      case 'clear-objects':
        return Array.isArray(op.objects) && op.objects.every(isValidObject);
      case 'resize-canvas':
        return isValidDimensions(op.from) && isValidDimensions(op.to);
      case 'set-background':
        return isColor(op.from) && isColor(op.to);
      case 'transform-objects':
        return Array.isArray(op.changes) && op.changes.every((c) =>
          c && typeof c.id === 'string' && isValidTransform(c.from) && isValidTransform(c.to));
      case 'set-groups':
        return Array.isArray(op.changes) && op.changes.every((c) => c && typeof c.id === 'string' &&
          (c.from === null || typeof c.from === 'string') && (c.to === null || typeof c.to === 'string'));
      case 'reorder':
        return isIdList(op.from) && isIdList(op.to);
      case 'arrange':
        return isIdList(op.from) && isIdList(op.to) && op.from.length === op.to.length &&
          Array.isArray(op.groups) && op.groups.every(isGroupChange);
      case 'set-flags':
        return Array.isArray(op.changes) && op.changes.every((c) => c && typeof c.id === 'string' &&
          isFlags(c.from) && isFlags(c.to));
      default:
        return false;
    }
  }

  function isValidEvent(e) {
    if (!e || typeof e.id !== 'string') return false;
    if (e.type === 'undo' || e.type === 'redo') return true;
    return e.type === 'op' && isValidOp(e.op);
  }

  function cleanCanvas(c) {
    if (!isValidDimensions(c)) throw new Error('invalid canvas');
    const background = /^#[0-9a-f]{6}$/i.test(c.background || '') ? c.background : '#FFFFFF';
    return { width: c.width, height: c.height, background };
  }

  function serialize(project, live) {
    return JSON.stringify({
      app: 'moji',
      schema: SCHEMA,
      savedAt: Date.now(),
      // the active branch's latest artwork, kept as a safety copy
      canvas: live.canvas,
      objects: live.objects,
      project: {
        base: project.base,
        branches: project.branches.map((b) => ({
          id: b.id,
          name: b.name,
          parentId: b.parentId,
          parentIndex: b.parentIndex,
          createdAt: b.createdAt,
          events: b.events,
        })),
        activeId: project.activeId,
        nextBranchNumber: project.nextBranchNumber,
      },
    });
  }

  function sameArtwork(a, b) {
    if (a.canvas.width !== b.canvas.width || a.canvas.height !== b.canvas.height) return false;
    if (a.objects.length !== b.objects.length) return false;
    return a.objects.every((o, i) => {
      const p = b.objects[i];
      return p.id === o.id && p.x === o.x && p.y === o.y && p.size === o.size && p.rotation === o.rotation;
    });
  }

  // returns { project, notice } or throws if even the artwork is unusable
  function parse(raw, defaults) {
    const data = JSON.parse(raw);
    if (!data || data.app !== 'moji') throw new Error('unrecognized project');
    if (data.schema === 1) return migrateFromV1(data, defaults);
    if (data.schema !== SCHEMA) throw new Error('unsupported project version');

    const savedArtwork = {
      canvas: cleanCanvas(data.canvas),
      objects: Array.isArray(data.objects) && data.objects.every(isValidObject) ? data.objects : null,
    };
    if (!savedArtwork.objects) throw new Error('invalid artwork');

    const p = data.project;
    const valid = p && p.base && Array.isArray(p.base.objects) && p.base.objects.every(isValidObject) &&
      Array.isArray(p.branches) && p.branches.length >= 1 && p.branches.length <= MAX_BRANCHES &&
      p.branches.every((b) => b && typeof b.id === 'string' && typeof b.name === 'string' &&
        (b.parentId === null || typeof b.parentId === 'string') && isIndex(b.parentIndex) &&
        Array.isArray(b.events) && b.events.every(isValidEvent)) &&
      p.branches.some((b) => b.id === p.activeId);

    if (valid) {
      try {
        const project = {
          base: { canvas: cleanCanvas(p.base.canvas), objects: p.base.objects },
          branches: p.branches.map((b) => ({
            id: b.id,
            name: b.name,
            parentId: b.parentId,
            parentIndex: b.parentIndex,
            createdAt: isFiniteNumber(b.createdAt) ? b.createdAt : Date.now(),
            events: b.events.map(deepFreeze),
          })),
          activeId: p.activeId,
          nextBranchNumber: Number.isInteger(p.nextBranchNumber) ? p.nextBranchNumber : p.branches.length,
          cache: new Map(),
        };
        // every branch must replay; the active one must match the safety copy
        project.branches.forEach((b) => latestState(project, b.id));
        const live = latestState(project, project.activeId);
        if (sameArtwork(live, savedArtwork)) return { project, notice: null };
      } catch (error) {
        // fall through: keep the artwork, start a fresh history
      }
    }
    return {
      project: createProject(savedArtwork),
      notice: 'the saved history could not be read; your artwork is kept and a new history starts',
      damaged: true,
    };
  }

  // 0.0.1 kept a single list of entries and a cursor. it becomes the
  // original branch: every entry as an op event, then one undo event per
  // entry beyond the cursor, which reproduces the same artwork and the same
  // undo/redo stacks. 0.0.1 did not record when undos happened, so imported
  // history shows each saved edit once.
  function migrateFromV1(data, defaults) {
    const saved = {
      canvas: cleanCanvas(data.canvas),
      objects: Array.isArray(data.objects) && data.objects.every(isValidObject) ? data.objects : null,
    };
    if (!saved.objects) throw new Error('invalid artwork');

    const h = data.history;
    const entries = h && Array.isArray(h.entries) ? h.entries : [];
    const cursor = h && Number.isInteger(h.cursor) ? h.cursor : entries.length;
    const entriesValid = entries.every(isValidOp) && cursor >= 0 && cursor <= entries.length;

    if (entriesValid && entries.length) {
      const project = createProject({ canvas: defaults.canvas, objects: [] });
      const root = project.branches[0];
      entries.forEach((entry) => {
        root.events.push(deepFreeze({ id: createId('evt'), type: 'op', at: entry.timestamp || Date.now(), op: entry }));
      });
      for (let i = entries.length; i > cursor; i -= 1) {
        root.events.push(deepFreeze({ id: createId('evt'), type: 'undo', at: Date.now() }));
      }
      try {
        if (sameArtwork(latestState(project, root.id), saved)) {
          return { project, notice: null, migrated: true };
        }
      } catch (error) {
        // fall through
      }
    }

    return {
      project: createProject(saved),
      notice: entries.length
        ? 'your artwork was kept, but its older undo history could not be carried over'
        : null,
      migrated: true,
    };
  }


  window.MojiHistory = {
    SCHEMA,
    MAX_BRANCHES,
    createId,
    deepFreeze,
    operations,
    step,
    createProject,
    getBranch,
    chain,
    chronology,
    branchPoints,
    stateAt,
    latestState,
    append,
    makeEvent,
    locate,
    canCreateBranch,
    createBranch,
    renameBranch,
    deleteBranch,
    makeTransition,
    sceneAt,
    isValidObject,
    serialize,
    parse,
  };
})();
