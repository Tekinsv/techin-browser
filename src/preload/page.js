'use strict';
// Runs at document start in every web page frame (sandboxed, isolated world).
// 1) Google sign-in pages: present Firefox's navigator values (the request
//    headers are rewritten in the main process). Never uses webContents.setUserAgent,
//    which crashes Chromium when called while a navigation is in flight.
// 2) Optional: hide WebAuthn so sites don't pop up the Windows passkey dialog.
// 3) Optional: Firefox-like smooth mouse-wheel scrolling, incl. snap feeds
//    (YouTube Shorts, Instagram Reels) that slide smoothly to the next item.
const { contextBridge, webFrame } = require('electron');

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

// ------------------------------------------------------------ 2b) Chrome Web Store
// The store calls chrome.webstorePrivate as soon as it loads. Electron exposes
// that API only half-implemented: getReferrerChain dereferences a missing
// Safe Browsing service and crashes the whole browser process. Hide the API
// before the store's own scripts run; the store then treats us as a browser
// that can't install extensions instead of crashing.
if (/^chromewebstore\.google\.com$|^chrome\.google\.com$/.test(location.hostname)) {
  inMain(() => {
    const c = window.chrome;
    if (!c) return;
    for (const k of ['webstorePrivate', 'management']) {
      try {
        Object.defineProperty(c, k, { value: undefined, configurable: false, enumerable: false, writable: false });
      } catch (e) {}
    }
  });
}

// ------------------------------------------------------------ 2c) YouTube Shorts ambient mode
// YouTube's server sends the Shorts "Ambient mode" switch with empty commands
// (a CLIENT_SIGNAL without actions), while ytd-shorts only turns the effect
// on/off through the TOGGLE_CINEMATIC_SHORTS_ON/OFF signal actions. So the
// switch flips but the glow stays. Add the missing actions to that switch as the
// data arrives (JSON.parse / fetch().json() / the inline ytInitialData).
const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(location.hostname);
if (IS_YOUTUBE) {
  inMain(() => {
    const FORM = '/youtube/app/shorts_cinematic_toggle_form';
    const switches = []; // patched switch data, re-rendered each time the menu opens
    // Saved Shorts ambient choice from the PREF cookie: flag 202 = user chose,
    // 201 = ambient on (31 flags per fN, so both live in f7). null = never chosen.
    const savedAmbient = () => {
      const pref = (document.cookie.split('; ').find((c) => c.startsWith('PREF=')) || '').slice(5);
      const f7 = parseInt((pref.split('&').find((p) => p.startsWith('f7=')) || '').slice(3), 16) || 0;
      return f7 & (1 << (202 - 186)) ? !!(f7 & (1 << (201 - 186))) : null;
    };
    document.addEventListener(
      'yt-action',
      (e) => {
        const name = e.detail && e.detail.actionName;
        if (name !== 'yt-signal-action-toggle-cinematic-shorts-on' && name !== 'yt-signal-action-toggle-cinematic-shorts-off') return;
        for (const sw of switches) sw.switchedOnByDefault = name.endsWith('-on');
      },
      true
    );
    const addActions = (cmd, signal) => {
      const list = cmd && cmd.innertubeCommand && cmd.innertubeCommand.commandExecutorCommand && cmd.innertubeCommand.commandExecutorCommand.commands;
      if (!Array.isArray(list)) return;
      for (const c of list) {
        const ep = c && c.signalServiceEndpoint;
        if (!ep || (Array.isArray(ep.actions) && ep.actions.length)) continue;
        ep.actions = [{ clickTrackingParams: c.clickTrackingParams, signalAction: { signal } }];
      }
    };
    const fix = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 60) return;
      if (Array.isArray(node)) {
        for (const x of node) fix(x, depth + 1);
        return;
      }
      const sw = node.switchListItemViewModel;
      if (sw && sw.formFieldMetadata && sw.formFieldMetadata.formId === FORM) {
        addActions(sw.switchOnCommand, 'TOGGLE_CINEMATIC_SHORTS_ON');
        addActions(sw.switchOffCommand, 'TOGGLE_CINEMATIC_SHORTS_OFF');
        // These signal commands never report completion, so with this flag set
        // every tap after the first one is ignored.
        sw.ignoreTapUntilCommandCompletes = false;
        // The switch shows a form value that YouTube fills from the *watch page*
        // ambient flag, not the Shorts one the toggle saves. Unbind it from that
        // form and show the saved Shorts choice instead, kept up to date below.
        delete sw.formFieldMetadata;
        const saved = savedAmbient();
        if (saved !== null) sw.switchedOnByDefault = saved;
        switches.push(sw);
        if (switches.length > 40) switches.shift();
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') fix(v, depth + 1);
      }
    };
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const out = parse.call(this, text, reviver);
      try {
        if (typeof text === 'string' && text.includes(FORM)) fix(out, 0);
      } catch (e) {}
      return out;
    };
    const json = Response.prototype.json;
    Response.prototype.json = function () {
      // Only YouTube's own API responses; everything else keeps the native path.
      if (!/\/youtubei\//.test(this.url || '')) return json.call(this);
      return this.text().then((t) => JSON.parse(t));
    };
    for (const name of ['ytInitialData']) {
      let value;
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          get: () => value,
          set: (v) => {
            try {
              fix(v, 0);
            } catch (e) {}
            value = v;
          }
        });
      } catch (e) {}
    }
  });
}

// ------------------------------------------------------------ 3) smooth wheel
// YouTube Shorts: one wheel notch = one video, slid with a compositor transform
// (see ytTransformSlide), so it stays smooth while YouTube is busy.
let ytNextAt = 0;
const YT_MODE = (argv.find((a) => a.startsWith('--techin-yt-mode=')) || '').split('=')[1] || 'transform';
if (IS_YOUTUBE && YT_MODE === 'snap') {
  try {
    webFrame.insertCSS('#shorts-container > :not(#cinematic-shorts-scrim) { scroll-snap-align: start; scroll-snap-stop: always; }');
  } catch {}
}
// Firefox-like Shorts slide. Measured in a 60 fps recording, Firefox starts
// fast and eases out (~380 ms) and never freezes, because its scrolling runs off
// the page's main thread. Chromium can't do that for YouTube's feed, but it CAN
// run transform animations off the main thread: slide the videos with a
// compositor transform, then jump the feed to the next video in one go (YouTube
// accepts that without any animation of its own) and only then let YouTube do
// its heavy video switch, when nothing is moving anymore.
let ytSlide = null; // { anim, inner, feed, target, start }
function ytItemTops(feed, inner) {
  const top = feed.getBoundingClientRect().top;
  const cur = feed.scrollTop;
  return [...inner.children]
    .filter((k) => /^\d+$/.test(k.id))
    .map((k) => Math.round(k.getBoundingClientRect().top - top + cur))
    .sort((a, b) => a - b);
}
function ytTransformSlide(down) {
  const feed = document.getElementById('shorts-container');
  const inner = document.getElementById('shorts-inner-container');
  if (!feed || !inner || typeof inner.animate !== 'function') return false;
  // After arriving from another YouTube page (SPA navigation) YouTube keeps a
  // pending "re-measure item height" flag; its first scroll handler then resets
  // the feed to the current video instead of switching. Do that re-measure now,
  // while nothing moves, so our final jump is taken as a real video change.
  inMain(() => {
    const c = document.querySelector('ytd-shorts')?.polymerController;
    if (!c || !c.shouldUpdateItemHeight || typeof c.updateItemHeight !== 'function') return;
    try {
      c.updateItemHeight();
      c.shouldUpdateItemHeight = false;
    } catch (e) {}
  });
  const tops = ytItemTops(feed, inner);
  if (tops.length < 2) return false;
  const cur = feed.scrollTop;
  const base = ytSlide ? ytSlide.target : cur;
  const target = down ? tops.find((p) => p > base + 20) : [...tops].reverse().find((p) => p < base - 20);
  if (target === undefined) return !!ytSlide; // end of feed
  const now = performance.now();
  // One physical notch can arrive as several wheel events: extend a running
  // slide only for a clearly separate notch, and never more than one video ahead.
  if (ytSlide && (now - ytSlide.start < 250 || Math.abs(ytSlide.target - cur) > 20)) return true;
  let from = 0;
  if (ytSlide) {
    try {
      from = new DOMMatrixReadOnly(getComputedStyle(inner).transform).m42;
    } catch {}
    ytSlide.anim.cancel();
  }
  const anim = inner.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${cur - target}px)` }], {
    // Matched to Firefox in a 60 fps recording: ~45% of the way in the first 80 ms,
    // then a long, soft ease-out.
    duration: 420,
    easing: 'cubic-bezier(0.25, 0.75, 0.3, 1)',
    fill: 'forwards'
  });
  // Chromium re-snaps a mandatory snap container when its snapped item moves -
  // which a transform does - and would scroll the feed back against the slide.
  if (!feed.dataset.techinSnap) {
    feed.dataset.techinSnap = feed.style.scrollSnapType || '-';
    feed.dataset.techinAnchor = feed.style.overflowAnchor || '-';
    feed.style.scrollSnapType = 'none';
    feed.style.overflowAnchor = 'none';
  }
  ytSlide = { anim, inner, feed, target, start: now };
  anim.onfinish = () => {
    if (!ytSlide || ytSlide.anim !== anim) return;
    ytSlide = null;
    // Same task: remove the transform and move the feed -> no visible jump.
    feed.scrollTo({ top: target, behavior: 'instant' });
    anim.cancel();
    const snap = feed.dataset.techinSnap;
    const anchor = feed.dataset.techinAnchor;
    feed.style.scrollSnapType = snap === '-' ? '' : snap;
    feed.style.overflowAnchor = anchor === '-' ? '' : anchor;
    delete feed.dataset.techinSnap;
    delete feed.dataset.techinAnchor;
  };
  return true;
}

function youtubeShortsWheel(e) {
  if (!IS_YOUTUBE || !location.pathname.startsWith('/shorts')) return false;
  if (YT_MODE === 'snap' || YT_MODE === 'native') return 'native';
  // Only wheel over the videos themselves switches video. Side panels inside
  // ytd-shorts (comments, description, ...) and anything scrollable on the way
  // (the comment list) scroll normally.
  let inFeed = false;
  for (const n of e.composedPath()) {
    if (!(n instanceof Element)) continue;
    if (n.id === 'shorts-container' || n.tagName === 'YTD-SHORTS') {
      inFeed = true;
      break;
    }
    if (n.tagName === 'YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER' || /engagement-panel|panel-container/.test(n.id)) return false;
    if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY)) return false;
  }
  if (!inFeed) return false;
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return false;
  e.preventDefault();
  if (YT_MODE !== 'key' && ytTransformSlide(e.deltaY > 0)) return true;
  const now = performance.now();
  if (now < ytNextAt) return true;
  ytNextAt = now + 450;
  inMain((down) => {
    const key = down ? 'ArrowDown' : 'ArrowUp';
    const code = down ? 40 : 38;
    const target = document.querySelector('ytd-shorts #shorts-player') || document.activeElement || document;
    // After arriving from another YouTube page the focus sits on a link and
    // YouTube ignores arrow keys: give the player focus first.
    if (target.focus && document.activeElement !== target) target.focus({ preventScroll: true });
    const init = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
    const before = location.pathname;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    // Fallback: YouTube's own up/down navigation buttons (same animation).
    setTimeout(() => {
      if (location.pathname !== before) return;
      const btn = document.querySelector((down ? '#navigation-button-down' : '#navigation-button-up') + ' button');
      if (btn) btn.click();
    }, 250);
  }, e.deltaY > 0);
  return true;
}
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
    const cur = getTop(a.el);
    a.last = a.last || now;
    if (a.lastSet !== undefined && Math.abs(cur - a.lastSet) > 1) a.hold = true;
    if (a.hold) {
      // The page keeps pulling the scroller back (YouTube Shorts holds it while it
      // switches videos). Only probe with 1px until it lets go, then slide from there.
      if (a.probe !== undefined && Math.abs(cur - a.probe) <= 0.5) {
        a.hold = false;
        a.probe = undefined;
        a.from = cur;
        a.elapsed = 0;
      } else {
        a.probe = cur + (a.to > cur ? 1 : -1);
        setTop(a.el, a.probe);
        a.lastSet = undefined;
        a.last = now;
        a.raf = requestAnimationFrame(run);
        return;
      }
    } else {
      a.elapsed += Math.min(now - a.last, 17);
    }
    a.last = now;
    const t = Math.min(1, a.elapsed / a.dur);
    const y = a.from + (a.to - a.from) * easeOut(t);
    setTop(a.el, y);
    a.lastSet = Math.round(y);
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
      const yt = youtubeShortsWheel(e);
      if (yt) return;
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
        // Real snap points: Chromium snaps on its compositor thread (never stalls). Let it.
        if (pts.length > 1) return;
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
