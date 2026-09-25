'use strict';
// Runs at document start in every web page frame (sandboxed, isolated world).
// 1) Google sign-in pages: present Firefox's navigator values (the request
//    headers are rewritten in the main process). Never uses webContents.setUserAgent,
//    which crashes Chromium when called while a navigation is in flight.
// 2) Optional: hide WebAuthn so sites don't pop up the Windows passkey dialog.
// 3) Optional: Firefox-like smooth mouse-wheel scrolling, incl. snap feeds
//    (YouTube Shorts, Instagram Reels) that slide smoothly to the next item.
const { contextBridge } = require('electron');

const argv = (typeof process !== 'undefined' && process.argv) || [];
const FLAG_NO_PASSKEYS = argv.includes('--techin-no-passkeys');
const FLAG_SMOOTH = argv.includes('--techin-smooth-wheel');

function inMain(func, ...args) {
  try {
    contextBridge.executeInMainWorld({ func, args });
  } catch {}
}

// ------------------------------------------------------------ 1) Google sign-in identity
if (/^accounts\.(google|youtube)\.[a-z.]+$/.test(location.hostname)) {
  const v = Math.max(140, parseInt((process.versions && process.versions.chrome) || '152', 10));
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
  inMain((ua) => {
    const def = (obj, k, val) => {
      try {
        Object.defineProperty(obj, k, { get: () => val, configurable: true });
      } catch (e) {}
    };
    def(Navigator.prototype, 'userAgent', ua);
    def(Navigator.prototype, 'appVersion', '5.0 (Windows)');
    def(Navigator.prototype, 'vendor', '');
    def(Navigator.prototype, 'productSub', '20100101');
    def(Navigator.prototype, 'userAgentData', undefined);
    try {
      delete window.chrome;
    } catch (e) {}
  }, ua);
}

// ------------------------------------------------------------ 2) no passkey pop-ups
if (FLAG_NO_PASSKEYS) {
  inMain(() => {
    try {
      delete window.PublicKeyCredential;
    } catch (e) {}
    const c = navigator.credentials;
    if (!c) return;
    const deny = () => Promise.reject(new DOMException('Passkeys are turned off in Techin Browser', 'NotAllowedError'));
    for (const name of ['get', 'create']) {
      const orig = c[name].bind(c);
      try {
        Object.defineProperty(c, name, { value: (opts) => (opts && opts.publicKey ? deny() : orig(opts)), configurable: true });
      } catch (e) {}
    }
  });
}

// ------------------------------------------------------------ 3) smooth wheel
if (FLAG_SMOOTH) {
  const DURATION = 360; // ms per wheel notch, like Firefox
  const SNAP_DURATION = 460; // one Short/Reel slides in
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  let anim = null;

  const rootScroller = () => document.scrollingElement || document.documentElement;
  const isRoot = (el) => el === rootScroller() || el === document.documentElement || el === document.body;
  const viewH = (el) => (isRoot(el) ? window.innerHeight : el.clientHeight);
  const maxTop = (el) => Math.max(0, (isRoot(el) ? rootScroller().scrollHeight : el.scrollHeight) - viewH(el));
  const getTop = (el) => (isRoot(el) ? rootScroller().scrollTop : el.scrollTop);
  const setTop = (el, y) => {
    const target = isRoot(el) ? window : el;
    target.scrollTo({ top: y, behavior: 'instant' });
  };

  function scrollable(el, dy) {
    if (isRoot(el)) {
      const cs = getComputedStyle(document.documentElement);
      const bs = document.body ? getComputedStyle(document.body) : null;
      if (cs.overflowY === 'hidden' || (bs && bs.overflowY === 'hidden' && cs.overflowY !== 'scroll' && cs.overflowY !== 'auto')) return false;
    } else {
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      if (el.scrollHeight <= el.clientHeight + 1) return false;
    }
    const top = getTop(el);
    return dy > 0 ? top < maxTop(el) - 1 : top > 0;
  }

  function findScroller(e, dy) {
    for (const node of e.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (node === document.documentElement || node === document.body) break;
      if (scrollable(node, dy)) return node;
    }
    const root = rootScroller();
    return scrollable(root, dy) ? root : null;
  }

  function snapType(el) {
    const st = getComputedStyle(isRoot(el) ? document.documentElement : el).scrollSnapType;
    return st && st !== 'none' && /y|block|both/.test(st) ? st : null;
  }

  /** Scroll positions the container can snap to (items up to 3 levels deep). */
  function snapPoints(el) {
    const container = isRoot(el) ? document.documentElement : el;
    const cTop = isRoot(el) ? 0 : el.getBoundingClientRect().top + el.clientTop;
    const top = getTop(el);
    const h = viewH(el);
    const out = [];
    let level = [...container.children];
    let seen = 0;
    for (let depth = 0; depth < 3 && level.length && seen < 400; depth++) {
      const next = [];
      for (const child of level) {
        if (++seen > 400) break;
        const align = getComputedStyle(child).scrollSnapAlign;
        if (align && align !== 'none') {
          const r = child.getBoundingClientRect();
          const a = align.split(' ')[0];
          let p = r.top - cTop + top;
          if (a === 'center') p -= (h - r.height) / 2;
          else if (a === 'end') p -= h - r.height;
          out.push(Math.max(0, Math.min(maxTop(el), Math.round(p))));
        } else {
          next.push(...child.children);
        }
      }
      level = next;
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  function run(now) {
    const a = anim;
    if (!a) return;
    // Advance by at most ~1.5 frames per callback: if the page's main thread was
    // busy (e.g. YouTube loading the next video) the slide pauses instead of jumping.
    a.elapsed += a.last ? Math.min(now - a.last, 25) : 0;
    a.last = now;
    const t = Math.min(1, a.elapsed / a.dur);
    setTop(a.el, a.from + (a.to - a.from) * easeOut(t));
    if (t < 1) {
      a.raf = requestAnimationFrame(run);
    } else {
      stop();
    }
  }

  function stop() {
    const a = anim;
    if (!a) return;
    anim = null;
    cancelAnimationFrame(a.raf);
    if (a.snapStyle !== undefined) {
      const box = isRoot(a.el) ? document.documentElement : a.el;
      box.style.scrollSnapType = a.snapStyle;
      box.style.overflowAnchor = a.anchorStyle || '';
    }
  }

  function animate(el, to, dur, snap) {
    const from = getTop(el);
    let snapStyle;
    let anchorStyle;
    if (anim && anim.el === el) {
      snapStyle = anim.snapStyle;
      anchorStyle = anim.anchorStyle;
      cancelAnimationFrame(anim.raf);
      anim = null;
    } else {
      stop();
    }
    if (snap && snapStyle === undefined) {
      // Let our animation drive; the container snaps again when we're done.
      const box = isRoot(el) ? document.documentElement : el;
      snapStyle = box.style.scrollSnapType;
      box.style.scrollSnapType = 'none';
      // Content loading around the feed (next video) must not shift the slide.
      anchorStyle = box.style.overflowAnchor;
      box.style.overflowAnchor = 'none';
    }
    anim = { el, from, to, elapsed: 0, last: 0, dur, snapStyle, anchorStyle, raf: 0 };
    anim.raf = requestAnimationFrame(run);
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.isTrusted || e.defaultPrevented || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY) return;
      // Touchpads already scroll smoothly: only take over for notched mouse wheels.
      const notched = e.deltaMode !== 0 || (e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0 && Math.abs(e.deltaY) >= 40);
      if (!notched) return;
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 40;
      else if (e.deltaMode === 2) dy *= window.innerHeight;
      const el = findScroller(e, dy);
      if (!el) return;
      const snap = snapType(el);
      let to;
      if (snap) {
        const base = anim && anim.el === el ? anim.to : getTop(el);

        const pts = snapPoints(el);
        if (dy > 0) to = pts.find((p) => p > base + 2);
        else to = [...pts].reverse().find((p) => p < base - 2);
        if (to === undefined) {
          // Feeds like YouTube Shorts declare snapping but no snap points: one notch
          // slides one full "page" (the next video), like Firefox does.
          const page = viewH(el);
          to = Math.max(0, Math.min(maxTop(el), Math.round(base / page) * page + (dy > 0 ? page : -page)));
          if (Math.abs(to - base) < 2) return;
        }
      } else {
        const base = anim && anim.el === el ? anim.to : getTop(el);
        to = Math.max(0, Math.min(maxTop(el), base + dy));
      }
      e.preventDefault();
      animate(el, to, snap ? SNAP_DURATION : DURATION, !!snap);

    },
    { passive: false }
  );

  // Any other way of scrolling (keys, scrollbar, touch) takes over immediately.
  for (const type of ['mousedown', 'keydown', 'touchstart']) window.addEventListener(type, stop, { capture: true, passive: true });
}
