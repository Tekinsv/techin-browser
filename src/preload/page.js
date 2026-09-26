'use strict';
// Runs at document start in every web page frame (sandboxed, isolated world).
// 1) Google sign-in pages: present Firefox's navigator values (the request
//    headers are rewritten in the main process). Never uses webContents.setUserAgent,
//    which crashes Chromium when called while a navigation is in flight.
// 2) Optional: hide WebAuthn so sites don't pop up the Windows passkey dialog.
// 3) Optional: Firefox-like smooth mouse-wheel scrolling, incl. snap feeds
//    (YouTube Shorts, Instagram Reels) that slide smoothly to the next item.
// 4) Password manager: offer to save logins, suggest saved ones on login fields.
const { contextBridge, webFrame, ipcRenderer } = require('electron');

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

// ------------------------------------------------------------ 3b) background tabs don't start media
// A page that starts hidden (a link opened in the background with the middle
// button) must not start playing video/audio on its own: nothing plays until the
// user has interacted with that page (clicked, pressed a key). Sites treat it as
// a blocked autoplay and show their play button. Pages opened normally are untouched.
if (document.visibilityState === 'hidden' && /^https?:$/.test(location.protocol)) {
  const allowed = () => !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  inMain(() => {
    const proto = HTMLMediaElement.prototype;
    const play = proto.play;
    const allowedMain = () => !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
    try {
      Object.defineProperty(proto, 'play', {
        configurable: true,
        writable: true,
        value: function () {
          if (allowedMain()) return play.apply(this, arguments);
          return Promise.reject(new DOMException('Playback waits until you interact with this tab', 'NotAllowedError'));
        }
      });
    } catch (e) {}
  });
  // The autoplay attribute doesn't go through play(): stop it as it starts.
  const hold = (e) => {
    if (!allowed() && e.target instanceof HTMLMediaElement) e.target.pause();
  };
  document.addEventListener('play', hold, true);
  document.addEventListener('playing', hold, true);
}

// ------------------------------------------------------------ 4) passwords
// Everything here runs in the isolated world: page scripts can't call
// ipcRenderer, can't see our suggestion list (closed shadow root) and can't
// fake a click on it (only trusted events fill). The main process decides the
// origin from the sending frame, so a page only ever gets its own logins.
if (/^https?:$/.test(location.protocol)) setupPasswords();

function setupPasswords() {
  const isPw = (el) => el instanceof HTMLInputElement && el.type === 'password';
  const isTextish = (el) => el instanceof HTMLInputElement && /^(text|email|tel|)$/.test(el.type) && !el.disabled && !el.readOnly;
  const USER_HINT = /user|e-?mail|login|account|identifier|phone|kullan|hesap|eposta/i;
  const looksUser = (el) =>
    isTextish(el) && (/username|email/.test(el.autocomplete || '') || el.type === 'email' || USER_HINT.test(`${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`));
  const shown = (el) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function userFieldFor(pw) {
    const scope = pw.form || document;
    const inputs = [...scope.querySelectorAll('input')].filter((i) => isTextish(i) && shown(i));
    const hinted = inputs.filter((i) => /username|email/.test(i.autocomplete || ''));
    if (hinted.length) return hinted[0];
    let best = null;
    for (const i of inputs) if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
    return best || inputs.find(looksUser) || null;
  }

  function passwordFields(scope) {
    return [...(scope || document).querySelectorAll('input[type="password"]')].filter((p) => shown(p));
  }

  // ---- saving: remember what was submitted, the main process asks after a successful-looking login
  let lastSent = '';
  function capture(pw) {
    const fields = passwordFields(pw.form).filter((p) => p.value);
    if (!fields.length) return;
    // Sign-up / change-password forms: the new password is the repeated one at the end.
    let password = fields[fields.length - 1].value;
    if (fields.length >= 2 && fields[fields.length - 1].value !== fields[fields.length - 2].value) password = fields[0].value;
    const userEl = userFieldFor(fields[0]);
    const username = userEl ? userEl.value.trim() : '';
    const sig = `${username}\n${password}`;
    if (sig === lastSent) return;
    lastSent = sig;
    setTimeout(() => (lastSent = ''), 3000);
    ipcRenderer.send('techin:pw', { type: 'submit', username, password });
    // Single-page logins don't navigate: no password field left on the page is our
    // hint (a failed login usually re-renders the form, so a field is still there).
    for (const ms of [800, 2000, 4500]) {
      setTimeout(() => {
        if (!passwordFields(document).length) ipcRenderer.send('techin:pw', { type: 'gone' });
      }, ms);
    }
  }

  document.addEventListener(
    'submit',
    (e) => {
      const pw = e.target instanceof HTMLFormElement && passwordFields(e.target).find((p) => p.value);
      if (pw) capture(pw);
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted && e.key === 'Enter' && isPw(e.target) && e.target.value) capture(e.target);
    },
    true
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const btn = e.target instanceof Element && e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!btn) return;
      const pw = passwordFields(btn.form || btn.closest('form') || document).find((p) => p.value);
      if (pw) capture(pw);
    },
    true
  );
  // Two-step logins (Google, Microsoft...): the username is typed on the page before.
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (e.isTrusted && looksUser(el) && el.value.trim() && !passwordFields(el.form || document).length) ipcRenderer.send('techin:pw', { type: 'user', value: el.value.trim() });
    },
    true
  );

  // ---- filling: a small list under the focused login field, filled on a real click
  let saved = null; // [{ id, username }] for this frame's origin
  let asking = null;
  let host = null;
  let box = null;
  let target = null;

  const setValue = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  function hide() {
    if (host) host.remove();
    target = null;
  }

  function place() {
    if (!host || !target || !shown(target)) return hide();
    const r = target.getBoundingClientRect();
    const below = r.bottom + 4 + 180 < innerHeight || r.top < 190;
    host.style.cssText = `all: initial; position: fixed; z-index: 2147483647; left: ${Math.round(Math.max(4, Math.min(r.left, innerWidth - 284)))}px; ${below ? `top: ${Math.round(r.bottom + 4)}px` : `bottom: ${Math.round(innerHeight - r.top + 4)}px`};`;
  }

  function build() {
    host = document.createElement('techin-passwords');
    const root = host.attachShadow({ mode: 'closed' });
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const style = document.createElement('style');
    style.textContent = `
      .box { font: 13px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; width: 280px; max-height: 176px; overflow: auto;
        background: ${dark ? '#1f232b' : '#ffffff'}; color: ${dark ? '#e8eaf0' : '#1b1f27'}; border: 1px solid ${dark ? '#343a46' : '#dde1e8'};
        border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.28); padding: 4px; }
      .hd { font-size: 11px; opacity: .6; padding: 6px 10px 4px; }
      button { all: unset; box-sizing: border-box; display: flex; gap: 10px; align-items: center; width: 100%; padding: 8px 10px; border-radius: 7px; cursor: pointer; }
      button:hover, button.on { background: ${dark ? '#2c3340' : '#eef2f8'}; }
      .k { width: 22px; height: 22px; flex: none; border-radius: 6px; display: grid; place-items: center; background: #3b6fe0; color: #fff; font-size: 12px; }
      .u { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .d { opacity: .55; margin-left: auto; letter-spacing: 1px; }`;
    box = document.createElement('div');
    box.className = 'box';
    root.append(style, box);
  }

  function render() {
    box.replaceChildren();
    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.textContent = 'Techin · kayıtlı parolalar';
    box.append(hd);
    for (const s of saved) {
      const b = document.createElement('button');
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = '🔑';
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = s.username || '(kullanıcı adı yok)';
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = '••••••';
      b.append(k, u, d);
      // mousedown keeps the focus in the field; the fill itself needs a trusted click
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        fill(s.id);
      });
      box.append(b);
    }
  }

  async function fill(id) {
    const field = target;
    hide();
    const cred = await ipcRenderer.invoke('techin:pw-fill', id).catch(() => null);
    if (!cred || !field || !field.isConnected) return;
    const scope = field.form || document;
    const pw = isPw(field) ? field : passwordFields(scope)[0];
    const user = pw ? userFieldFor(pw) : isTextish(field) ? field : null;
    if (user && cred.username) setValue(user, cred.username);
    if (pw) setValue(pw, cred.password);
  }

  async function show(el) {
    if (!saved) {
      asking = asking || ipcRenderer.invoke('techin:pw-query').catch(() => []);
      saved = await asking;
      asking = null;
    }
    if (!saved.length || document.activeElement !== el) return;
    if (!host) build();
    target = el;
    render();
    place();
    document.documentElement.append(host);
  }

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (isPw(el) || (looksUser(el) && (passwordFields(el.form || document).length || /username|email/.test(el.autocomplete || '')))) show(el);
    },
    true
  );
  document.addEventListener(
    'focusout',
    () =>
      setTimeout(() => {
        if (target && document.activeElement !== target) hide();
      }, 150),
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && host && host.isConnected) hide();
    },
    true
  );
  // Typing means the user isn't picking a saved login.
  document.addEventListener('input', (e) => e.isTrusted && e.target === target && hide(), true);
  addEventListener('scroll', () => host && host.isConnected && place(), { capture: true, passive: true });
  addEventListener('resize', () => host && host.isConnected && place(), { passive: true });
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
// The same slide works for any full-page snap feed (Instagram Reels, TikTok...):
// see snapFeedWheel() in the smooth-wheel section.
let feedSlideState = null; // { anims, movers, feed, target, start, snap, anchor }

function endFeedSlide(jump) {
  const s = feedSlideState;
  if (!s) return;
  feedSlideState = null;
  // Same task: move the feed and remove the transform -> no visible jump.
  if (jump) s.feed.scrollTo({ top: s.target, behavior: 'instant' });
  for (const a of s.anims) a.cancel();
  s.feed.style.scrollSnapType = s.snap;
  s.feed.style.overflowAnchor = s.anchor;
}

/**
 * Slides `movers` (the feed's content) one item up/down with a compositor
 * transform, then scrolls `feed` to that item. `tops` = the item scroll positions.
 * Returns true when the wheel event was handled.
 */
function feedSlide(feed, movers, tops, down) {
  if (tops.length < 2 || !movers.length || typeof movers[0].animate !== 'function') return false;
  let s = feedSlideState;
  if (s && s.feed !== feed) {
    endFeedSlide(true);
    s = null;
  }
  const cur = feed.scrollTop;
  const base = s ? s.target : cur;
  const target = down ? tops.find((p) => p > base + 20) : [...tops].reverse().find((p) => p < base - 20);
  if (target === undefined) return !!s; // end of feed
  const now = performance.now();
  // One physical notch can arrive as several wheel events: extend a running
  // slide only for a clearly separate notch, and never more than one item ahead.
  if (s && (now - s.start < 250 || Math.abs(s.target - cur) > 20)) return true;
  let from = 0;
  if (s) {
    try {
      from = new DOMMatrixReadOnly(getComputedStyle(s.movers[0]).transform).m42;
    } catch {}
    for (const a of s.anims) a.cancel();
  }
  const frames = [{ transform: `translateY(${from}px)` }, { transform: `translateY(${cur - target}px)` }];
  // Matched to Firefox in a 60 fps recording: ~45% of the way in the first 80 ms,
  // then a long, soft ease-out.
  const timing = { duration: 420, easing: 'cubic-bezier(0.25, 0.75, 0.3, 1)', fill: 'forwards' };
  const anims = movers.map((m) => m.animate(frames, timing));
  const next = { anims, movers, feed, target, start: now, snap: s ? s.snap : feed.style.scrollSnapType, anchor: s ? s.anchor : feed.style.overflowAnchor };
  if (!s) {
    // Chromium re-snaps a mandatory snap container when its snapped item moves -
    // which a transform does - and would scroll the feed back against the slide.
    feed.style.scrollSnapType = 'none';
    feed.style.overflowAnchor = 'none';
  }
  feedSlideState = next;
  anims[0].onfinish = () => {
    if (feedSlideState === next) endFeedSlide(true);
  };
  return true;
}

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
  return feedSlide(feed, [inner], ytItemTops(feed, inner), down);
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

  /** Snap items of the container (up to 3 levels deep) with their scroll position. */
  function snapItems(el) {
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
          out.push({ el: child, p: Math.max(0, Math.min(maxTop(el), Math.round(p))) });
        } else {
          next.push(...child.children);
        }
      }
      level = next;
    }
    return out.sort((a, b) => a.p - b.p);
  }

  /** Scroll positions the container can snap to. */
  function snapPoints(el) {
    return [...new Set(snapItems(el).map((i) => i.p))];
  }

  /**
   * Full-page snap feeds (Instagram Reels, TikTok, ...): one notch slides one
   * item with the same compositor transform as YouTube Shorts. Chromium's own
   * wheel + snap there creeps for ~200 ms and then jumps. Returns true if handled.
   */
  function snapFeedWheel(el, down) {
    if (isRoot(el)) return false;
    const items = snapItems(el);
    const tops = [...new Set(items.map((i) => i.p))];
    if (tops.length < 2) return false;
    // Only feeds of page-sized items; small snap rows (carousels, lists) stay native.
    const gaps = tops.slice(1).map((p, i) => p - tops[i]).sort((a, b) => a - b);
    const h = viewH(el);
    if (gaps[Math.floor(gaps.length / 2)] < h * 0.6) return false;
    // What to move: the feed's direct children that hold the items near the
    // current position (a single wrapper if all items live in one).
    const base = feedSlideState && feedSlideState.feed === el ? feedSlideState.target : el.scrollTop;
    const movers = new Set();
    for (const i of items) {
      if (i.p < base - 2 * h || i.p > base + 3 * h) continue;
      let n = i.el;
      while (n.parentElement && n.parentElement !== el) n = n.parentElement;
      if (n.parentElement === el) movers.add(n);
    }
    if (!movers.size) return false;
    // A mover with its own transform would be overwritten by the slide: leave it native.
    for (const m of movers) if (getComputedStyle(m).transform !== 'none' && !(feedSlideState && feedSlideState.movers.includes(m))) return false;
    return feedSlide(el, [...movers], tops, down);
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
        if (pts.length > 1) {
          // Page-sized feeds slide Firefox-like; other snap containers (carousels,
          // lists) keep Chromium's own snapping.
          if (snapFeedWheel(el, dy > 0)) e.preventDefault();
          return;
        }
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
