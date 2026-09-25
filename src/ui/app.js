'use strict';
// Techin Browser UI renderer. All page-provided text (titles, URLs) is only
// ever inserted with textContent — never as HTML.
(() => {
  const T = window.techin;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  let S = null;
  let lang = 'tr';
  let lastLang = null;
  const t = (k, ...a) => window.TechinI18n.translate(lang, k, ...a);
  const cmd = (action, args) => T.cmd(action, args).catch((err) => T.log(`${action}: ${err.message}`));

  // ------------------------------------------------------------ helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const ico = (name, cls) => window.icon(name, cls);

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function hueOf(s) {
    let x = 7;
    for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360;
    return x;
  }

  function letter(url, title, cls = '') {
    const base = hostOf(url) || title || '?';
    const el = h('span', { class: 'letter ' + cls, text: (base.match(/[\p{L}\p{N}]/u) || ['?'])[0] });
    el.style.setProperty('background', `hsl(${hueOf(base)} 52% 48%)`);
    return el;
  }

  function favEl(favicon, url, title) {
    if (typeof favicon === 'string' && favicon.startsWith('data:image/')) {
      const img = h('img', { src: favicon, alt: '', draggable: 'false' });
      img.addEventListener('error', () => img.replaceWith(letter(url, title)));
      return img;
    }
    return letter(url, title);
  }

  function fmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toLocaleString(lang, { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${u[i]}`;
  }

  function debounce(fn, ms) {
    let tm;
    return (...a) => {
      clearTimeout(tm);
      tm = setTimeout(() => fn(...a), ms);
    };
  }

  /** Keyed list diff that keeps DOM nodes (and their animations) alive. */
  function reconcile(container, items, key, create, update, animateOut = true) {
    const existing = new Map();
    for (const el of [...container.children]) {
      if (el.classList.contains('drop-line')) el.remove();
      else if (el.dataset.key && !el.classList.contains('leaving')) existing.set(el.dataset.key, el);
    }
    const keep = new Set();
    let prev = null;
    for (const item of items) {
      const k = key(item);
      keep.add(k);
      let el = existing.get(k);
      if (!el) {
        el = create(item);
        el.dataset.key = k;
      }
      update(el, item);
      const ref = prev ? prev.nextSibling : container.firstChild;
      if (el !== ref) container.insertBefore(el, ref);
      prev = el;
    }
    for (const [k, el] of existing) {
      if (keep.has(k)) continue;
      if (animateOut) {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 180);
      } else el.remove();
    }
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setIcon(el, name) {
    if (el.dataset.icon === name) return;
    el.dataset.icon = name;
    el.replaceChildren(ico(name));
  }

  // ------------------------------------------------------------ theme & layout

  function applyTheme() {
    const { mode, hue, material, scale } = S.theme;
    const inc = S.win.incognito;
    const dark = inc || mode === 'dark';
    root.dataset.mode = dark ? 'dark' : 'light';
    root.dataset.material = inc ? 'gradient' : material;
    root.dataset.incognito = inc ? '1' : '0';
    let g1;
    let g2;
    let accent;
    let fg;
    const h2 = (hue + 32) % 360;
    if (inc) {
      g1 = '#1b1526';
      g2 = '#2c2042';
      accent = '#b79bff';
      fg = '#f1ecfb';
    } else if (dark) {
      g1 = material === 'mica' ? `hsl(${hue} 30% 12% / 0.55)` : `hsl(${hue} 36% 13%)`;
      g2 = material === 'mica' ? `hsl(${h2} 34% 18% / 0.55)` : `hsl(${h2} 40% 21%)`;
      accent = `hsl(${hue} 88% 70%)`;
      fg = '#eef2f8';
    } else {
      g1 = material === 'mica' ? `hsl(${hue} 70% 94% / 0.5)` : `hsl(${hue} 62% 89%)`;
      g2 = material === 'mica' ? `hsl(${h2} 60% 88% / 0.5)` : `hsl(${h2} 56% 81%)`;
      accent = `hsl(${hue} 72% 42%)`;
      fg = `hsl(${hue} 32% 14%)`;
    }
    root.style.setProperty('--g1', g1);
    root.style.setProperty('--g2', g2);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--fg', fg);
    root.style.setProperty('--fs', { small: '12px', normal: '13px', large: '14.5px' }[scale] || '13px');
    // Panels, dialogs and the start page take their colors from the space's hue,
    // so everything reads as one design instead of a separate gray app.
    const ph = inc ? 265 : hue;
    const pal = dark
      ? { card: `hsl(${ph} 22% 10%)`, surface: `hsl(${ph} 20% 14%)`, surface2: `hsl(${ph} 18% 19%)`, line: `hsl(${ph} 18% 22%)`, pop: `hsl(${ph} 22% 13%)`, fg: '#eceff5', fg2: `hsl(${ph} 12% 70%)`, fg3: `hsl(${ph} 10% 52%)`, on: '#0b1220' }
      : { card: `hsl(${ph} 30% 99%)`, surface: `hsl(${ph} 32% 96%)`, surface2: `hsl(${ph} 26% 92%)`, line: `hsl(${ph} 22% 89%)`, pop: '#ffffff', fg: `hsl(${ph} 25% 14%)`, fg2: `hsl(${ph} 10% 38%)`, fg3: `hsl(${ph} 8% 55%)`, on: '#ffffff' };
    for (const [k, v] of Object.entries({ '--card': pal.card, '--surface': pal.surface, '--surface-2': pal.surface2, '--card-line': pal.line, '--pop': pal.pop, '--card-fg': pal.fg, '--card-fg-2': pal.fg2, '--card-fg-3': pal.fg3, '--on-accent': pal.on })) root.style.setProperty(k, v);
  }

  let resizing = null;

  function applyLayout() {
    const L = S.layout;
    root.classList.toggle('compact', L.compact);
    root.classList.toggle('side-right', L.side === 'right');
    root.classList.toggle('bare', S.win.bare);
    root.classList.toggle('modal-open', !!S.modal);
    root.classList.toggle('page-visible', L.pageVisible);
    const px = (v) => `${Math.round(v)}px`;
    if (!resizing) root.style.setProperty('--sbw', px(L.sidebar));
    root.style.setProperty('--cx', px(L.content.x));
    root.style.setProperty('--cy', px(L.content.y));
    root.style.setProperty('--cw', px(L.content.width));
    root.style.setProperty('--ch', px(L.content.height));
    root.style.setProperty('--radius', px(L.radius));
    root.style.setProperty('--gap', px(L.gap));
    root.style.setProperty('--inset', px(L.topInset));
    // Hole over the live page while a dialog is open (page stays visible, dimmed).
    const x = L.content.x;
    const y = L.content.y + L.topInset;
    const w = L.content.width;
    const hh = L.content.height - L.topInset;
    const r = Math.min(L.radius, w / 2, hh / 2);
    root.style.setProperty(
      '--hole',
      `path(evenodd, "M0 0H${L.W}V${L.H}H0Z M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + hh - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + hh}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + hh - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z")`
    );
    root.classList.toggle('sb-hidden', !!L.hidden);
    root.style.setProperty('--tbh', px(L.top || 40));
    // Split view: accent ring around the focused half, error page limited to that half.
    const ring = $('panefocus');
    const panes = L.panes || [];
    const focused = panes.length === 2 ? panes.find((p) => p.tabId === (S.active && S.active.id)) : null;
    ring.classList.toggle('on', !!focused && !S.modal);
    if (focused) {
      for (const [k, v] of Object.entries({ left: focused.x - 3, top: focused.y - 3, width: focused.width + 6, height: focused.height + 6 })) ring.style.setProperty(k, px(v));
    }
    const ep = $('errorpage');
    const active = panes.length === 2 ? focused : null;
    ep.style.setProperty('--pane-x', px(active ? active.x - L.content.x : 0));
    ep.style.setProperty('--pane-r', px(active ? L.content.x + L.content.width - (active.x + active.width) : 0));
  }
  function translateStatic() {
    for (const el of document.querySelectorAll('[data-tip]')) el.title = t(el.dataset.tip);
    root.lang = lang;
    setIcon($('btn-back'), 'back');
    setIcon($('btn-sidebar'), 'sidebar');
    setIcon($('btn-copy'), 'link');
    setIcon($('btn-siteinfo'), 'settings');
    setIcon($('btn-split'), 'split');
    setIcon($('btn-fwd'), 'forward');
    setIcon($('space-menu'), 'more');
    setIcon($('btn-newspace'), 'plus');
    setIcon($('btn-menu'), 'more');
    $('btn-newspace').title = t('Yeni alan');
    $('btn-menu').title = t('Menü');
    $('space-menu').title = t('Alan seçenekleri');
    const nt = $('btn-newtab');
    nt.querySelector('.fi').replaceChildren(ico('plus'));
    nt.querySelector('.t').textContent = t('Yeni sekme');
    nt.title = t('Yeni sekme (Ctrl+T)');
    const clr = $('btn-clear');
    clr.replaceChildren(ico('arrowDown'), t('Temizle'));
    clr.title = t('Bu alandaki sekmeleri kapat');
    $('space-name').dataset.inc = t('Gizli');
  }

  // ------------------------------------------------------------ sidebar

  function renderTop() {
    const a = S.active;
    $('btn-back').disabled = !a || !a.canGoBack;
    $('btn-fwd').disabled = !a || !a.canGoForward;
    const loading = a && a.loading;
    setIcon($('btn-reload'), loading ? 'x' : 'reload');
    $('btn-reload').title = loading ? t('Durdur (Esc)') : t('Yenile (F5)');
    $('btn-reload').disabled = !a;
    const max = document.querySelector('.winctl .max');
    const maxed = S.win.maximized || S.win.fullscreen;
    setText(max, maxed ? '' : '');
    max.title = maxed ? t('Önceki boyut') : t('Ekranı kapla');
    const inSplit = !!(S.split && a && S.split.includes(a.id));
    $('btn-split').classList.toggle('on', inSplit);
    $('btn-split').disabled = !a;
    renderUpdatePill();
  }

  function renderUpdatePill() {
    const u = S.update;
    const pill = $('btn-update');
    let label = '';
    let iconName = 'download';
    if (u && u.status === 'available') label = t('Güncelleme var');
    else if (u && u.status === 'downloading') label = t('İndiriliyor %{0}', u.percent);
    else if (u && u.status === 'ready') {
      label = t('Yeniden başlat ve güncelle');
      iconName = 'reset';
    } else if (u && u.status === 'error' && u.version) label = t('Güncelleme hatası');
    pill.classList.toggle('hidden', !label);
    const sig = label + iconName;
    if (label && pill.dataset.sig !== sig) {
      pill.dataset.sig = sig;
      pill.replaceChildren(ico(iconName), label);
      pill.title = u.version ? `Techin Browser ${u.version}` : '';
    }
  }

  function renderUrlbar() {
    const a = S.active;
    const bar = $('urlbar');
    const sec = $('sec');
    let secIcon = 'search';
    let secClass = '';
    let secTip = '';
    if (a) {
      const map = {
        secure: ['lock', '', t('Bağlantı güvenli')],
        insecure: ['warn', 'insecure', t('Güvenli değil')],
        'cert-error': ['warn', 'cert-error', t('Sertifika hatası')],
        file: ['file', '', t('Yerel dosya')],
        local: ['globe', '', t('Yerel ağ')],
        none: ['globe', '', '']
      };
      [secIcon, secClass, secTip] = map[a.security] || map.none;
    }
    setIcon(sec, secIcon);
    sec.className = 'sec ' + secClass + (a && (a.security === 'secure' || a.security === 'none') ? ' plain' : '');
    $('tbcenter').classList.toggle('empty', !a);
    sec.title = secTip ? `${secTip} — ${t('site bilgisi')}` : '';
    const host = $('host');
    const text = a ? a.host || a.title || t('Yeni sekme') : t('Ara veya adres yaz…');
    if (!a) secIcon = 'search';
    if (host.dataset.v !== text) {
      host.dataset.v = text;
      host.replaceChildren(a && a.security === 'insecure' ? h('span', { class: 'dim', text: t('Güvenli değil') + ' · ' }) : '', text);
    }
    bar.classList.toggle('loading', !!(a && a.loading));
    const zc = $('zoomchip');
    const showZoom = a && Math.abs(a.zoom - 1) > 0.001;
    zc.classList.toggle('hidden', !showZoom);
    if (showZoom) {
      setText(zc, Math.round(a.zoom * 100) + '%');
      zc.title = t('Yakınlaştırmayı sıfırla');
    }
    const sh = $('shield');
    const adOn = S.settings.adblock && a && /^https?:/.test(a.url);
    const showShield = adOn && (a.adblockOff || a.blocked > 0);
    sh.classList.toggle('hidden', !showShield);
    if (showShield) {
      const key = a.adblockOff ? 'off' : 'n' + a.blocked;
      if (sh.dataset.v !== key) {
        sh.dataset.v = key;
        sh.replaceChildren(ico(a.adblockOff ? 'shieldOff' : 'shieldCheck'), a.adblockOff ? '' : String(a.blocked));
      }
      sh.title = a.adblockOff ? t('Bu sitede engelleyici kapalı') : t('{0} reklam/izleyici engellendi', a.blocked);
    }
  }

  function renderFavorites() {
    const box = $('favorites');
    box.classList.toggle('empty-drop', !S.favorites.length && !!drag);
    reconcile(
      box,
      S.favorites,
      (f) => f.id,
      (f) => {
        const el = h('div', { class: 'fav', draggable: 'true', dataset: { item: f.id } });
        return el;
      },
      (el, f) => {
        el.classList.toggle('active', f.active);
        el.classList.toggle('open', f.open);
        el.classList.toggle('sleeping', f.sleeping);
        el.title = f.title + (f.sleeping && f.open ? ` (${t('uyuyor')})` : '');
        const sig = `${f.favicon ? f.favicon.length : 0}|${f.loading}|${f.audible}|${f.muted}`;
        if (el.dataset.sig !== sig) {
          el.dataset.sig = sig;
          el.replaceChildren(favEl(f.favicon, f.url, f.title));
          if (f.loading) el.append(h('span', { class: 'spin' }));
          if (f.audible || f.muted) el.append(h('span', { class: 'badge' }, ico(f.muted ? 'volumeX' : 'volume')));
        }
      },
      false
    );
  }

  function renderSpaceHead() {
    const sp = S.spaces.find((x) => x.id === S.activeSpaceId);
    setText($('space-emoji'), sp && sp.icon ? sp.icon : '');
    setText($('space-name'), sp ? sp.name : '');
    $('space-emoji').classList.toggle('hidden', !(sp && sp.icon));
  }

  function tabRow(kind) {
    const el = h(
      'div',
      { class: 'row' + (kind === 'item' ? ' pinned-row' : ''), draggable: 'true' },
      h('span', { class: 'fi' }),
      h('span', { class: 't' })
    );
    return el;
  }

  function updateRow(el, d, kind) {
    el.classList.toggle('active', !!d.active);
    el.classList.toggle('sleeping', !!d.sleeping);
    el.classList.toggle('crashed', !!d.crashed);
    el.classList.toggle('split', !!(S.split && S.split.includes(kind === 'item' ? d.tabId : d.id)));
    if (kind === 'item') {
      el.dataset.item = d.id;
      if (d.tabId) el.dataset.tab = d.tabId;
      else delete el.dataset.tab;
    } else el.dataset.tab = d.id;
    if (!el.querySelector('input.rename')) setText(el.querySelector('.t'), d.title);
    el.title = d.title + (d.url ? '\n' + d.url : '') + (d.sleeping && (kind !== 'item' || d.open) ? `\n${t('Uyuyor — bellek boşaltıldı')}` : '');
    const fi = el.querySelector('.fi');
    const fsig = `${d.loading}|${d.favicon ? d.favicon.slice(-40) + d.favicon.length : d.url}`;
    if (fi.dataset.sig !== fsig) {
      fi.dataset.sig = fsig;
      fi.replaceChildren(d.loading ? h('span', { class: 'spin' }) : favEl(d.favicon, d.url, d.title));
    }
    // trailing controls
    const want = [];
    if (d.audible || d.muted) want.push('aud');
    if (kind === 'item' && d.moved) want.push('reset');
    if (kind !== 'item' || d.open) want.push('x');
    const sig = want.join(',') + (d.muted ? 'm' : '');
    if (el.dataset.ctl !== sig) {
      el.dataset.ctl = sig;
      for (const c of el.querySelectorAll('.aud,.reset,.x')) c.remove();
      if (want.includes('aud')) el.append(h('span', { class: 'aud', title: d.muted ? t('Sesi aç') : t('Sessize al') }, ico(d.muted ? 'volumeX' : 'volume')));
      if (want.includes('reset')) el.append(h('span', { class: 'reset', title: t('Sabit adrese dön') }, ico('reset')));
      if (want.includes('x')) el.append(h('span', { class: 'x', title: kind === 'item' ? t('Sayfayı kapat') : t('Kapat (Ctrl+W)') }, ico('x')));
    }
  }

  function renderLists() {
    reconcile($('pinned'), S.pinned, (d) => 'i' + d.id, () => tabRow('item'), (el, d) => updateRow(el, d, 'item'));
    reconcile($('today'), S.tabs, (d) => 't' + d.id, () => tabRow('tab'), (el, d) => updateRow(el, d, 'tab'));
    $('btn-clear').classList.toggle('hidden', !S.tabs.length);
  }

  function renderStatus() {
    const st = $('status');
    const url = S.active && S.active.hoverUrl;
    st.classList.toggle('show', !!url);
    if (url) setText(st, url.replace(/^https?:\/\/(www\.)?/, ''));
  }

  function renderFoot() {
    reconcile(
      $('spaces'),
      S.spaces,
      (sp) => sp.id,
      (sp) => h('button', { class: 'sp', dataset: { space: sp.id } }),
      (el, sp) => {
        el.classList.toggle('active', sp.id === S.activeSpaceId);
        el.title = sp.name;
        const sig = sp.icon || 'dot';
        if (el.dataset.sig !== sig) {
          el.dataset.sig = sig;
          el.replaceChildren(sp.icon ? sp.icon : h('span', { class: 'dot' }));
        }
      },
      false
    );
    const dl = S.downloads;
    const btn = $('btn-downloads');
    const sig = dl.active ? 'ring' + Math.round(dl.progress * 100) : 'idle';
    if (btn.dataset.sig !== sig) {
      btn.dataset.sig = sig;
      btn.replaceChildren(ico('download'));
      if (dl.active) {
        const C = 2 * Math.PI * 10;
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ring.setAttribute('class', 'ring');
        ring.setAttribute('viewBox', '0 0 24 24');
        const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const bar = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        for (const c of [track, bar]) {
          c.setAttribute('cx', '12');
          c.setAttribute('cy', '12');
          c.setAttribute('r', '10');
        }
        track.setAttribute('class', 'track');
        bar.setAttribute('class', 'bar');
        bar.setAttribute('stroke-dasharray', String(C));
        bar.setAttribute('stroke-dashoffset', String(dl.progress >= 0 ? C * (1 - dl.progress) : C * 0.7));
        ring.append(track, bar);
        btn.append(ring);
      }
    }
    btn.title = dl.active ? t('{0} indirme sürüyor', dl.active) : t('İndirilenler (Ctrl+J)');
  }

  // ------------------------------------------------------------ sidebar events

  $('btn-back').addEventListener('click', () => cmd('nav.back'));
  $('btn-fwd').addEventListener('click', () => cmd('nav.forward'));
  $('btn-reload').addEventListener('click', (e) => cmd(S.active && S.active.loading ? 'nav.stop' : 'nav.reload', { hard: e.shiftKey }));
  for (const b of document.querySelectorAll('[data-win]')) {
    b.addEventListener('click', () => cmd({ min: 'window.minimize', max: 'window.maximize', close: 'window.close' }[b.dataset.win]));
  }
  $('urlbar').addEventListener('click', (e) => {
    if (e.target.closest('#sec') && S.active && S.active.security !== 'secure') return cmd('site.info');
    cmd('palette.open', { mode: S.active ? 'edit' : 'new' });
  });
  $('zoomchip').addEventListener('click', () => cmd('zoom.reset'));
  $('shield').addEventListener('click', () => cmd('site.info'));
  $('btn-copy').addEventListener('click', () => cmd('tab.copyUrl'));
  $('btn-siteinfo').addEventListener('click', () => cmd('site.info'));
  $('btn-split').addEventListener('click', () => cmd('split.toggle'));
  $('btn-appmenu').addEventListener('click', () => cmd('menu.app'));
  $('btn-sidebar').addEventListener('click', () => cmd('settings.set', { key: 'sidebarHidden', value: !S.settings.sidebarHidden }));
  $('btn-update').addEventListener('click', () => cmd('update.open'));
  $('btn-newtab').addEventListener('click', () => cmd('palette.open', { mode: 'new' }));
  $('btn-clear').addEventListener('click', () => cmd('tabs.clearToday'));
  $('btn-downloads').addEventListener('click', () => cmd('panel.open', { name: 'downloads' }));
  $('btn-newspace').addEventListener('click', () => cmd('space.new'));
  $('btn-menu').addEventListener('click', () => cmd('menu.app'));
  $('space-menu').addEventListener('click', () => cmd('menu.space', { spaceId: S.activeSpaceId }));
  $('spacehead').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cmd('menu.space', { spaceId: S.activeSpaceId });
  });
  $('spacehead').addEventListener('dblclick', () => cmd('space.edit', { spaceId: S.activeSpaceId }));

  $('spaces').addEventListener('click', (e) => {
    const b = e.target.closest('[data-space]');
    if (b) cmd('space.switch', { spaceId: b.dataset.space });
  });
  $('spaces').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-space]');
    if (!b) return;
    e.preventDefault();
    cmd('menu.space', { spaceId: b.dataset.space });
  });

  // Horizontal swipe on the sidebar switches spaces (like Arc).
  let swipe = 0;
  let swipeLock = 0;
  $('sidebar').addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !S || S.spaces.length < 2) return;
      if (Date.now() < swipeLock) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) > 90) {
        const i = S.spaces.findIndex((s) => s.id === S.activeSpaceId);
        const next = S.spaces[(i + (swipe > 0 ? 1 : -1) + S.spaces.length) % S.spaces.length];
        swipe = 0;
        swipeLock = Date.now() + 450;
        cmd('space.switch', { spaceId: next.id });
      }
    },
    { passive: true }
  );

  $('favorites').addEventListener('click', (e) => {
    const f = e.target.closest('.fav');
    if (f) cmd('item.open', { itemId: f.dataset.item });
  });
  $('favorites').addEventListener('auxclick', (e) => {
    const f = e.target.closest('.fav');
    if (f && e.button === 1) cmd('item.close', { itemId: f.dataset.item });
  });
  $('favorites').addEventListener('contextmenu', (e) => {
    const f = e.target.closest('.fav');
    if (!f) return;
    e.preventDefault();
    cmd('menu.item', { itemId: f.dataset.item });
  });

  function onListClick(e) {
    const row = e.target.closest('.row');
    if (!row || row.querySelector('input.rename')) return;
    const tabId = row.dataset.tab;
    const itemId = row.dataset.item;
    if (e.target.closest('.x')) return itemId ? cmd('item.close', { itemId }) : cmd('tab.close', { tabId });
    if (e.target.closest('.aud') && tabId) return cmd('tab.mute', { tabId });
    if (e.target.closest('.reset') && itemId) {
      cmd('item.open', { itemId });
      return cmd('nav.resetItem');
    }
    if (itemId) return cmd('item.open', { itemId });
    if (tabId) cmd('tab.activate', { tabId });
  }
  for (const id of ['pinned', 'today']) {
    const list = $(id);
    list.addEventListener('click', onListClick);
    list.addEventListener('auxclick', (e) => {
      const row = e.target.closest('.row');
      if (!row || e.button !== 1) return;
      if (row.dataset.item) cmd('item.close', { itemId: row.dataset.item });
      else cmd('tab.close', { tabId: row.dataset.tab });
    });
    list.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll cursor
    });
    list.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      e.preventDefault();
      if (row.dataset.item) cmd('menu.item', { itemId: row.dataset.item });
      else cmd('menu.tab', { tabId: row.dataset.tab });
    });
  }
  $('pinned').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row && row.dataset.item) startRename(row.dataset.item);
  });
  $('sbscroll').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.row')) return;
    e.preventDefault();
    cmd('menu.app');
  });

  function startRename(itemId) {
    const row = $('pinned').querySelector(`.row[data-item="${CSS.escape(itemId)}"]`);
    if (!row || row.querySelector('input.rename')) return;
    const label = row.querySelector('.t');
    const input = h('input', { class: 'rename', value: label.textContent, spellcheck: 'false' });
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      input.replaceWith(label);
      if (save) cmd('item.rename', { itemId, title: input.value.slice(0, 200) });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Sidebar width drag
  $('resizer').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    $('resizer').setPointerCapture(e.pointerId);
    resizing = { last: 0 };
  });
  // Firefox-style: pull the edge far enough left and the sidebar snaps into an
  // icon strip; pull it back out and it opens again.
  const COLLAPSE_AT = 130;
  $('resizer').addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const w = Math.round(S.layout.side === 'left' ? e.clientX : S.layout.W - e.clientX);
    const compact = w < COLLAPSE_AT;
    if (compact !== resizing.compact) {
      resizing.compact = compact;
      cmd('settings.set', { key: 'sidebarCompact', value: compact });
    }
    if (compact) {
      root.style.setProperty('--sbw', '52px');
      resizing.width = null;
      return;
    }
    const width = Math.max(180, Math.min(420, w));
    root.style.setProperty('--sbw', width + 'px');
    const now = performance.now();
    if (now - resizing.last > 40) {
      resizing.last = now;
      cmd('sidebar.resize', { width });
    }
    resizing.width = width;
  });
  $('resizer').addEventListener('pointerdown', () => {
    if (resizing) resizing.compact = !!S.layout.compact;
  });
  const endResize = () => {
    if (!resizing) return;
    if (resizing.width) cmd('sidebar.resize', { width: resizing.width });
    resizing = null;
  };
  $('resizer').addEventListener('pointerup', endResize);
  $('resizer').addEventListener('pointercancel', endResize);
  // Double-click the edge: toggle between icon strip and normal width.
  $('resizer').addEventListener('dblclick', () => cmd('settings.set', { key: 'sidebarCompact', value: !S.layout.compact }));

  // ------------------------------------------------------------ drag & drop

  let drag = null;

  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest && e.target.closest('.row[draggable], .fav[draggable]');
    if (!el || el.classList.contains('newtab')) return;
    const isItem = !!el.dataset.item;
    const list = el.parentElement.id;
    drag = { type: isItem ? 'item' : 'tab', id: isItem ? el.dataset.item : el.dataset.tab, list, from: [...el.parentElement.children].filter((c) => c.dataset.key).indexOf(el), el };
    const data = isItem ? [...S.favorites, ...S.pinned].find((x) => x.id === drag.id) : S.tabs.find((x) => x.id === drag.id);
    if (data && data.url) {
      e.dataTransfer.setData('text/uri-list', data.url);
      e.dataTransfer.setData('text/plain', data.url);
    }
    e.dataTransfer.effectAllowed = 'copyMove';
    requestAnimationFrame(() => el.classList.add('dragging'));
    if (!S.favorites.length) $('favorites').classList.add('empty-drop');
  });

  document.addEventListener('dragend', () => {
    if (drag && drag.el) drag.el.classList.remove('dragging');
    drag = null;
    clearDropUi();
    if (S) renderFavorites();
  });

  function clearDropUi() {
    for (const el of document.querySelectorAll('.drop-line')) el.remove();
    for (const el of document.querySelectorAll('.drop-here')) el.classList.remove('drop-here');
    $('favorites').classList.remove('empty-drop');
  }

  function dropIndex(container, e, grid) {
    const kids = [...container.children].filter((c) => c.dataset.key && !c.classList.contains('leaving'));
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (grid) {
        if (e.clientY < r.top) return i;
        if (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) return i;
      } else if (e.clientY < r.top + r.height / 2) return i;
    }
    return kids.length;
  }

  function dropTarget(e) {
    if (e.target.closest('#favorites')) return { list: 'favorites', el: $('favorites'), grid: true };
    if (e.target.closest('#pinned')) return { list: 'pinned', el: $('pinned') };
    if (e.target.closest('#today, #divider, #btn-newtab')) return { list: 'today', el: $('today') };
    const scroll = e.target.closest('#sbscroll');
    if (scroll) {
      const pr = $('pinned').getBoundingClientRect();
      return e.clientY < pr.bottom + 4 ? { list: 'pinned', el: $('pinned') } : { list: 'today', el: $('today') };
    }
    return null;
  }

  const isExternal = (e) => !drag && [...e.dataTransfer.types].some((x) => x === 'Files' || x === 'text/uri-list' || x === 'text/plain');

  document.addEventListener('dragover', (e) => {
    if (!drag && !isExternal(e)) return;
    const target = dropTarget(e);
    e.preventDefault();
    clearDropUi();
    if (!drag) {
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (!target) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    if (target.grid) {
      target.el.classList.add('drop-here');
      return;
    }
    const idx = dropIndex(target.el, e, false);
    const kids = [...target.el.children].filter((c) => c.dataset.key && !c.classList.contains('leaving'));
    const line = h('div', { class: 'drop-line' });
    if (idx < kids.length) target.el.insertBefore(line, kids[idx]);
    else target.el.append(line);
    target.el.classList.add('drop-here');
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = dropTarget(e);
    if (!drag) {
      // Links or files dropped from outside: open them.
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) {
        for (const f of files.slice(0, 10)) {
          const p = T.pathForFile(f);
          if (p) cmd('nav.open', { text: p, newTab: true });
        }
      } else {
        const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
        if (text) cmd('nav.open', { text, newTab: true });
      }
      clearDropUi();
      return;
    }
    if (!target) return clearDropUi();
    let index = dropIndex(target.el, e, !!target.grid);
    const sameList = drag.list === target.list;
    if (sameList && drag.from >= 0 && drag.from < index) index--;
    const d = drag;
    clearDropUi();
    if (d.type === 'tab') {
      if (target.list === 'today') cmd('tab.move', { tabId: d.id, index });
      else cmd('tab.pin', { tabId: d.id, kind: target.list === 'favorites' ? 'favorite' : 'pinned', index });
    } else {
      if (target.list === 'today') cmd('item.unpin', { itemId: d.id, index });
      else cmd('item.move', { itemId: d.id, kind: target.list === 'favorites' ? 'favorite' : 'pinned', index });
    }
  });

  // ------------------------------------------------------------ content area

  function renderContent() {
    const a = S.active;
    const panel = S.panel;
    const showError = !panel && a && (a.error || a.crashed);
    const showStart = !panel && !a;
    $('start').classList.toggle('hidden', !showStart);
    $('panel').classList.toggle('hidden', !panel);
    $('errorpage').classList.toggle('hidden', !showError);
    if (showStart) renderStart();
    if (panel) renderPanel();
    else panelKey = null;
    if (showError) renderError();
    else errorKey = null;
  }

  // ---- start page
  let startBuilt = false;
  let clockTimer = null;

  function greeting() {
    const hr = new Date().getHours();
    if (hr < 5) return t('İyi geceler');
    if (hr < 12) return t('Günaydın');
    if (hr < 18) return t('İyi günler');
    return t('İyi akşamlar');
  }

  const TIPS = [
    'İpucu: Ctrl+T ile her yerden arayın ve komut çalıştırın.',
    'İpucu: Sekmeyi yukarıdaki kutucuklara sürükleyip sık kullanılanlara ekleyin.',
    'İpucu: Ctrl+Shift+S kenar çubuğunu daraltır.',
    'İpucu: Kullanmadığınız sekmeler uyutulur ve RAM boşaltılır.',
    'İpucu: Kenar çubuğunda iki parmakla yana kaydırarak alan değiştirin.',
    'İpucu: Videoya sağ tıklayıp "Resim içinde resim" ile izleyin.'
  ];

  function renderStart() {
    const box = $('start');
    const sig = `${lang}|${JSON.stringify(S.topSites || [])}|${S.settings.onboarded}|${S.win.incognito}`;
    if (!startBuilt || box.dataset.sig !== sig) {
      startBuilt = true;
      box.dataset.sig = sig;
      const clock = h('div', { class: 'clock' });
      const greet = h('div', { class: 'greet' });
      const tick = () => {
        clock.textContent = new Date().toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
        greet.textContent = S.win.incognito ? t('Gizli pencere — geçmiş ve çerezler kaydedilmez') : greeting();
      };
      tick();
      clearInterval(clockTimer);
      clockTimer = setInterval(() => !box.classList.contains('hidden') && tick(), 15000);
      const kids = [
        h('div', { class: 'brand' }, h('img', { src: 'assets/logo.png', alt: '' }), clock, greet),
        h(
          'button',
          { class: 'search', onclick: () => cmd('palette.open', { mode: 'new' }) },
          ico('search'),
          t('Ara veya adres yaz…'),
          h('kbd', { text: 'Ctrl T' })
        )
      ];
      if (!S.settings.onboarded && !S.win.incognito) {
        kids.push(
          h(
            'div',
            { class: 'welcome' },
            h('h3', { text: t("Techin Browser'a hoş geldiniz") }),
            h(
              'ul',
              null,
              h('li', { text: t('Sekmeleriniz solda: yukarıda sık kullanılanlar, ortada sabitlenenler, altta günlük sekmeler.') }),
              h('li', { text: t('Reklam ve izleyici engelleyici, zararlı site koruması ve yalnızca HTTPS modu açık.') }),
              h('li', { text: t('Tema, renk ve yerleşimi Ayarlar > Görünüm bölümünden değiştirebilirsiniz.') })
            ),
            h(
              'div',
              { class: 'actions' },
              h('button', { class: 'btn primary', onclick: () => cmd('settings.set', { key: 'onboarded', value: true }) }, t('Başlayalım')),
              h('button', { class: 'btn ghost', onclick: () => cmd('panel.open', { name: 'settings' }) }, t('Ayarları aç'))
            )
          )
        );
      } else if (S.topSites && S.topSites.length) {
        kids.push(
          h(
            'div',
            { class: 'tiles' },
            S.topSites.map((s, i) =>
              h(
                'button',
                { class: 'tile', title: s.url, style: { 'animation-delay': `${i * 30}ms` }, onclick: () => cmd('nav.open', { text: s.url, newTab: true }) },
                letter(s.url, s.title),
                h('span', { class: 'name', text: s.host })
              )
            )
          )
        );
      }
      kids.push(h('div', { class: 'tip', text: t(TIPS[Math.floor(Date.now() / 3.6e6) % TIPS.length]) }));
      box.replaceChildren(...kids);
    }
  }

  // ---- error page
  let errorKey = null;

  function renderError() {
    const a = S.active;
    const e = a.error || { kind: 'crash' };
    const key = `${lang}|${a.id}|${a.crashed}|${e.kind}|${e.code}|${e.url}`;
    if (errorKey === key) return;
    errorKey = key;
    const host = e.host || hostOf(e.url || a.url) || e.url || '';
    const act = (op) => () => cmd('error.action', { op });
    const primary = (label, op) => h('button', { class: 'btn primary', onclick: act(op) }, label);
    const secondary = (label, op) => h('button', { class: 'btn', onclick: act(op) }, label);
    let icon = 'warn';
    let danger = false;
    let title;
    let desc;
    let actions = [primary(t('Tekrar dene'), 'retry')];
    let advanced = null;
    if (a.crashed) {
      icon = 'sad';
      title = a.crashed === 'oom' ? t('Bu sayfanın belleği tükendi') : t('Bu sayfa çöktü');
      desc = t('Sayfanın işlemi beklenmedik şekilde kapandı. Diğer sekmeleriniz etkilenmedi.');
      actions = [h('button', { class: 'btn primary', onclick: () => cmd('nav.reload') }, t('Yeniden yükle'))];
    } else {
      switch (e.kind) {
        case 'dns':
          icon = 'globe';
          title = t('Bu siteye ulaşılamıyor');
          desc = t('{0} adresinin sunucusu bulunamadı. Adresi doğru yazdığınızdan emin olun.', host);
          break;
        case 'offline':
          icon = 'wifiOff';
          title = t('İnternet bağlantısı yok');
          desc = t('Modem, kablo veya Wi‑Fi bağlantınızı kontrol edip tekrar deneyin.');
          break;
        case 'network':
          title = t('Bu siteye ulaşılamıyor');
          desc = t('{0} bağlantıyı reddetti ya da zamanında yanıt vermedi.', host);
          break;
        case 'tls':
          icon = 'lock';
          title = t('Güvenli bağlantı kurulamadı');
          desc = t('{0} desteklenmeyen ya da eski bir güvenlik protokolü kullanıyor.', host);
          break;
        case 'cert':
          danger = true;
          title = t('Bağlantınız gizli değil');
          desc = t('Saldırganlar {0} sitesinden bilgilerinizi (şifreler, mesajlar, kartlar) çalmaya çalışıyor olabilir.', host);
          actions = [primary(t('Güvenli yere dön'), 'back')];
          advanced = [
            h('p', { text: t('Bu sitenin güvenlik sertifikası geçerli değil ({0}). Bu, sitenin yanlış yapılandırıldığı ya da bağlantınıza birinin müdahale ettiği anlamına gelebilir.', e.cert ? e.cert.error : e.desc) }),
            e.cert && e.cert.fingerprint ? h('button', { class: 'btn danger small', onclick: act('proceed') }, t('{0} sitesine devam et (güvenli değil)', host)) : null
          ];
          break;
        case 'https-only':
          icon = 'unlock';
          title = t('Bu site güvenli bağlantıyı desteklemiyor');
          desc = t('Techin, {0} sitesine HTTPS ile bağlanmayı denedi ama olmadı. HTTP ile devam ederseniz gönderdiğiniz bilgileri ağdaki başkaları görebilir.', host);
          actions = [primary(t('Geri dön'), 'back'), secondary(t('HTTP ile devam et'), 'http')];
          break;
        case 'malware':
          danger = true;
          icon = 'shield';
          title = t('Tehlikeli site engellendi');
          desc = t('{0}, zararlı yazılım dağıttığı bilinen siteler listesinde (URLhaus). Bu site bilgisayarınıza virüs bulaştırmaya çalışabilir.', host);
          actions = [primary(t('Güvenli yere dön'), 'back')];
          advanced = [h('p', { text: t('Riskleri anlıyorsanız bu siteyi yine de açabilirsiniz.') }), h('button', { class: 'btn danger small', onclick: act('proceed') }, t('Riski anlıyorum, devam et'))];
          break;
        case 'phishing':
          danger = true;
          icon = 'shield';
          title = t('Sahte (oltalama) site engellendi');
          desc = t('{0}, şifre veya kart bilgilerinizi çalmak için başka bir siteyi taklit ettiği bildirilen siteler listesinde.', host);
          actions = [primary(t('Güvenli yere dön'), 'back')];
          advanced = [h('p', { text: t('Riskleri anlıyorsanız bu siteyi yine de açabilirsiniz.') }), h('button', { class: 'btn danger small', onclick: act('proceed') }, t('Riski anlıyorum, devam et'))];
          break;
        case 'blocked':
          icon = 'shield';
          title = t('Bu sayfa engellendi');
          desc = t('Techin bu isteği engelledi.');
          break;
        case 'redirects':
          title = t('Bu sayfa çalışmıyor');
          desc = t('{0} sizi çok fazla kez yönlendirdi. Bu sitenin çerezlerini temizlemeyi deneyin.', host);
          break;
        case 'file':
          icon = 'file';
          title = t('Dosya bulunamadı');
          desc = t('Dosya taşınmış ya da silinmiş olabilir.');
          break;
        default:
          title = t('Sayfa yüklenemedi');
          desc = t('{0} yüklenirken bir hata oluştu.', host);
      }
    }
    const box = h(
      'div',
      { class: 'err' + (danger ? ' danger' : '') },
      h('div', { class: 'big' }, ico(icon)),
      h('h1', { text: title }),
      h('p', { text: desc }),
      e.desc && !a.crashed ? h('code', { text: `${e.desc} (${e.code})` }) : null,
      h('div', { class: 'actions' }, actions),
      advanced ? h('details', null, h('summary', { text: t('Gelişmiş') }), advanced) : null
    );
    $('errorpage').replaceChildren(box);
  }

  // ------------------------------------------------------------ panels

  let panelKey = null;
  let panelSyncs = [];
  let settingsSection = 'appearance';
  let memTimer = null;
  let historyQuery = '';

  function renderPanel() {
    const key = `${S.panel}|${lang}|${S.panel === 'settings' ? settingsSection : ''}`;
    if (panelKey !== key) {
      panelKey = key;
      panelSyncs = [];
      clearInterval(memTimer);
      const titles = { settings: t('Ayarlar'), history: t('Geçmiş'), downloads: t('İndirilenler') };
      const head = h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: titles[S.panel] }),
        S.panel === 'history' ? historySearch() : null,
        S.panel === 'downloads'
          ? h(
              'div',
              { class: 'actions' },
              h('button', { class: 'btn ghost small', onclick: () => cmd('app.openDownloadDir') }, ico('folder'), t('Klasörü aç')),
              h('button', { class: 'btn ghost small', onclick: () => cmd('downloads.clear') }, t('Listeyi temizle'))
            )
          : null,
        h('button', { class: 'ib', title: t('Kapat (Esc)'), onclick: () => cmd('panel.close') }, ico('x'))
      );
      let body;
      if (S.panel === 'settings') body = buildSettings();
      else if (S.panel === 'history') body = buildHistory();
      else body = buildDownloads();
      $('panel').replaceChildren(head, body);
    }
    for (const fn of panelSyncs) fn();
  }

  // ---- settings controls

  const setSetting = (key, value) => cmd('settings.set', { key, value });

  function toggle(key, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => (onChange ? onChange(input.checked) : setSetting(key, input.checked)));
    panelSyncs.push(() => {
      if (key) input.checked = !!S.settings[key];
    });
    return h('label', { class: 'switch' }, input, h('span'));
  }

  function seg(key, options) {
    const wrap = h('div', { class: 'seg' });
    for (const [v, label] of options) {
      wrap.append(h('button', { dataset: { v: String(v) }, onclick: () => setSetting(key, v) }, t(label)));
    }
    panelSyncs.push(() => {
      for (const b of wrap.children) b.classList.toggle('on', b.dataset.v === String(S.settings[key]));
    });
    return wrap;
  }

  function range(key, min, max, fmt = (v) => v + ' px') {
    const label = h('span', { class: 'val' });
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: '1' });
    const send = debounce((v) => setSetting(key, v), 60);
    input.addEventListener('input', () => {
      label.textContent = fmt(Number(input.value));
      send(Number(input.value));
    });
    panelSyncs.push(() => {
      if (document.activeElement !== input) {
        input.value = String(S.settings[key]);
        label.textContent = fmt(S.settings[key]);
      }
    });
    return h('div', { class: 'chips' }, input, label);
  }

  function row(title, desc, ctl) {
    return h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', { text: t(title) }), desc ? h('small', { text: t(desc) }) : null), ctl);
  }

  function group(title, ...rows) {
    return [title ? h('div', { class: 'group-title', text: t(title) }) : null, h('div', { class: 'group' }, rows)];
  }

  const SECTIONS = [
    ['appearance', 'Görünüm', 'palette'],
    ['search', 'Arama', 'search'],
    ['privacy', 'Gizlilik ve güvenlik', 'shield'],
    ['sites', 'Site izinleri', 'key'],
    ['performance', 'Performans', 'zap'],
    ['downloads', 'İndirmeler', 'download'],
    ['general', 'Genel', 'settings'],
    ['about', 'Hakkında', 'info']
  ];

  function buildSettings() {
    const nav = h('nav', { class: 'snav' });
    for (const [id, label, icn] of SECTIONS) {
      nav.append(h('button', { class: id === settingsSection ? 'on' : '', onclick: () => ((settingsSection = id), renderPanel()) }, ico(icn), t(label)));
    }
    const inner = h('div', { class: 'inner' });
    const banner = h(
      'div',
      { class: 'restart-banner hidden' },
      ico('reset'),
      h('span', { text: t('Bazı değişiklikler tarayıcı yeniden başlayınca etkinleşir.') }),
      h('button', { class: 'btn primary small', onclick: () => cmd('app.relaunch') }, t('Yeniden başlat'))
    );
    panelSyncs.push(() => banner.classList.toggle('hidden', !S.meta.restartNeeded));
    inner.append(banner, h('div', { class: 'group-title big', text: t(SECTIONS.find((s) => s[0] === settingsSection)[1]) }));
    const builders = { appearance: secAppearance, search: secSearch, privacy: secPrivacy, sites: secSites, performance: secPerformance, downloads: secDownloads, general: secGeneral, about: secAbout };
    inner.append(...builders[settingsSection]().flat().filter(Boolean));
    return h('div', { class: 'panel-body' }, nav, h('div', { class: 'panel-scroll' }, inner));
  }

  const HUES = [214, 250, 280, 330, 0, 25, 45, 150, 175, 195];

  function secAppearance() {
    const presets = h('div', { class: 'presets' });
    for (const hue of HUES) {
      const b = h('button', {
        class: 'preset',
        title: `${hue}°`,
        style: { background: `linear-gradient(135deg, hsl(${hue} 62% 70%), hsl(${(hue + 32) % 360} 56% 55%))` },
        onclick: () => cmd('space.save', { id: S.activeSpaceId, hue })
      });
      b.dataset.hue = String(hue);
      presets.append(b);
    }
    panelSyncs.push(() => {
      for (const b of presets.children) b.classList.toggle('on', Number(b.dataset.hue) === S.theme.hue);
    });
    return [
      group(
        'Tema',
        row('Renk modu', 'Sistem, Windows ayarınızı izler. Web siteleri de bu modu kullanır.', seg('theme', [['system', 'Sistem'], ['light', 'Açık'], ['dark', 'Koyu']])),
        row('Arka plan', 'Mika, Windows 11 masaüstünüzü hafifçe arkadan gösterir.', seg('material', [['gradient', 'Renk geçişi'], ['mica', 'Mika']])),
        row('Bu alanın rengi', 'Her alanın kendi rengi olabilir.', presets),
        row('Arayüz yazı boyutu', null, seg('uiScale', [['small', 'Küçük'], ['normal', 'Normal'], ['large', 'Büyük']]))
      ),
      group(
        'Yerleşim',
        row('Kenar çubuğu konumu', null, seg('sidebarSide', [['left', 'Sol'], ['right', 'Sağ']])),
        row('Kompakt kenar çubuğu', 'Yalnızca simgeler görünür. Kenar çubuğunun kenarını sola doğru çekerek de daraltabilirsiniz.', toggle('sidebarCompact')),
        row('Kenar çubuğu genişliği', null, range('sidebarWidth', 200, 420)),
        row('Sayfa çevresindeki boşluk', null, range('contentGap', 0, 16)),
        row('Köşe yuvarlaklığı', null, range('cornerRadius', 0, 18)),
        row('Bağlantı önizlemesi', 'Fareyle üzerine geldiğiniz bağlantının adresini kenar çubuğunda gösterir.', toggle('showHoverUrl'))
      )
    ];
  }

  function secSearch() {
    const engines = [
      ['google', 'Google'],
      ['duckduckgo', 'DuckDuckGo'],
      ['bing', 'Bing'],
      ['brave', 'Brave Search'],
      ['startpage', 'Startpage'],
      ['ecosia', 'Ecosia'],
      ['yandex', 'Yandex'],
      ['custom', 'Özel…']
    ];
    const sel = h('select', { class: 'sel' }, engines.map(([v, l]) => h('option', { value: v, text: t(l) })));
    sel.addEventListener('change', () => setSetting('searchEngine', sel.value));
    const custom = h('input', { class: 'txtin', placeholder: 'https://ornek.com/ara?q=%s', spellcheck: 'false' });
    const hint = h('small');
    custom.addEventListener('change', () => {
      const v = custom.value.trim();
      if (v === '' || /^https:\/\/.+%s/.test(v)) {
        hint.textContent = '';
        setSetting('customSearchUrl', v);
      } else hint.textContent = t('Adres https:// ile başlamalı ve aranan kelime yerine %s içermeli.');
    });
    const customRow = h('div', { class: 'setting col' }, h('div', { class: 'txt' }, h('b', { text: t('Özel arama adresi') }), h('small', { text: t('Arama kelimesinin geleceği yere %s yazın.') })), custom, hint);
    panelSyncs.push(() => {
      if (document.activeElement !== sel) sel.value = S.settings.searchEngine;
      if (document.activeElement !== custom) custom.value = S.settings.customSearchUrl;
      customRow.classList.toggle('hidden', S.settings.searchEngine !== 'custom');
    });
    return [
      group(
        null,
        row('Arama motoru', 'Adres çubuğuna yazdığınız aramalar burada yapılır.', sel),
        customRow,
        row('Arama önerileri', 'Siz yazarken arama motorundan öneriler alır (yazdıklarınız arama motoruna gönderilir).', toggle('searchSuggestions'))
      )
    ];
  }

  function secPrivacy() {
    const adStatus = h('small');
    const threatStatus = h('small');
    panelSyncs.push(() => {
      const p = S.protection;
      adStatus.textContent =
        p.adblock === 'ready' ? t('{0} kural yüklü. Reklamlar ve izleyiciler sayfalar yüklenmeden engellenir; sayfalar daha hızlı açılır, daha az RAM kullanılır.', p.rules.toLocaleString(lang)) : p.adblock === 'error' ? t('Listeler indirilemedi, internet bağlantısı gelince tekrar denenecek.') : t('Listeler yükleniyor…');
      const th = p.threats;
      threatStatus.textContent =
        th.malware || th.phishing
          ? t('{0} zararlı ve {1} sahte site listede. Son güncelleme: {2}', th.malware.toLocaleString(lang), th.phishing.toLocaleString(lang), th.updated ? new Date(th.updated).toLocaleString(lang) : '—')
          : t('Liste henüz indirilmedi.');
    });
    const allow = h('div', { class: 'chips' });
    panelSyncs.push(() => {
      const list = S.settings.adblockAllowlist;
      const sig = list.join(',');
      if (allow.dataset.sig === sig) return;
      allow.dataset.sig = sig;
      allow.replaceChildren(...(list.length ? list.map((host) => h('span', { class: 'chip2' }, host, ' ', h('button', { title: t('Kaldır'), onclick: () => cmd('site.adblock', { host, enabled: true }) }, '×'))) : [h('small', { class: 'muted', text: t('Yok') })]));
    });
    const what = { history: true, cookies: false, cache: true, downloads: false, permissions: false };
    const checks = h(
      'div',
      { class: 'chips' },
      [
        ['history', 'Tarama geçmişi'],
        ['cookies', 'Çerezler ve site verileri'],
        ['cache', 'Önbellek'],
        ['downloads', 'İndirme listesi'],
        ['permissions', 'Site izinleri']
      ].map(([k, l]) => {
        const cb = h('input', { type: 'checkbox', checked: what[k] });
        cb.addEventListener('change', () => (what[k] = cb.checked));
        return h('label', { class: 'chip2' }, cb, ' ', t(l));
      })
    );
    const rangeSel = h(
      'select',
      { class: 'sel' },
      [
        ['hour', 'Son 1 saat'],
        ['day', 'Son 24 saat'],
        ['week', 'Son 7 gün'],
        ['all', 'Tüm zamanlar']
      ].map(([v, l]) => h('option', { value: v, text: t(l) }))
    );
    const clearBtn = h(
      'button',
      {
        class: 'btn danger small',
        onclick: () =>
          cmd('data.clear', {
            what: Object.keys(what).filter((k) => what[k]),
            range: rangeSel.value
          })
      },
      ico('trash'),
      t('Temizle')
    );
    return [
      group(
        'Koruma',
        h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', { text: t('Reklam ve izleyici engelleyici') }), adStatus), toggle('adblock')),
        row('Engelleme düzeyi', 'Sıkı düzey çerez uyarılarını ve rahatsız edici öğeleri de gizler.', seg('adblockLevel', [['standard', 'Standart'], ['strict', 'Sıkı']])),
        h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', { text: t('Zararlı ve sahte site koruması') }), threatStatus), toggle('malwareProtection')),
        row('Yalnızca HTTPS modu', 'Siteleri her zaman şifreli bağlantıyla açar; olmazsa size sorar.', toggle('httpsOnly')),
        row('Takip etme sinyali (GPC)', 'Sitelere verilerinizi satmamalarını ve paylaşmamalarını söyler.', toggle('gpc')),
        row('Geçiş anahtarı (Windows Hello) istemleri', 'Kapalıyken siteler şifre yerine Windows Güvenliği PIN penceresini açamaz. Yeniden başlatma gerekir.', toggle('passkeys')),
        row('Engelleyicinin kapalı olduğu siteler', null, allow)
      ),
      group(
        'Tarama verileri',
        h('div', { class: 'setting col' }, h('div', { class: 'txt' }, h('b', { text: t('Tarama verilerini temizle') }), h('small', { text: t('Çerezler ve önbellek, seçilen süreden bağımsız olarak tamamen temizlenir.') })), checks, h('div', { class: 'chips' }, rangeSel, clearBtn)),
        row('Çıkışta temizle', 'Tarayıcı kapanınca geçmiş, çerezler ve önbellek silinir.', toggle('clearOnExit'))
      )
    ];
  }

  const PERM_NAMES = {
    camera: 'Kamera',
    microphone: 'Mikrofon',
    geolocation: 'Konum',
    notifications: 'Bildirimler',
    midiSysex: 'MIDI cihazları',
    'clipboard-read': 'Pano okuma',
    'idle-detection': 'Boşta algılama',
    'window-management': 'Pencere yönetimi'
  };

  function secSites() {
    const list = h('div', { class: 'group' }, h('div', { class: 'setting' }, h('small', { text: t('Yükleniyor…') })));
    const load = () =>
      cmd('site.permissions.list').then((rows) => {
        if (!rows || !rows.length) {
          list.replaceChildren(h('div', { class: 'empty' }, ico('key'), t('Henüz hiçbir siteye izin verilmedi veya engellenmedi.')));
          return;
        }
        list.replaceChildren(
          ...rows.map((r) =>
            h(
              'div',
              { class: 'setting' },
              h(
                'div',
                { class: 'txt' },
                h('b', { text: r.origin.replace(/^https:\/\//, '') }),
                h('div', { class: 'chips' }, Object.entries(r.perms).map(([p, v]) => h('span', { class: 'chip2 ' + v, text: `${t(PERM_NAMES[p] || p)}: ${v === 'allow' ? t('İzin verildi') : t('Engellendi')}` })))
              ),
              h('button', { class: 'btn small', onclick: () => cmd('site.permissions.clear', { origin: r.origin }).then(load) }, t('Sıfırla'))
            )
          )
        );
      });
    load();
    return [h('p', { class: 'group-title', text: t('Siteler kamera, mikrofon, konum veya bildirim istediğinde size sorulur. Verdiğiniz yanıtlar burada listelenir.') }), list];
  }

  function secPerformance() {
    const stats = h('div', { class: 'mem-top' });
    const rows = h('div');
    const refresh = () =>
      cmd('memory.stats').then((m) => {
        if (!m) return;
        const stat = (v, l) => h('div', { class: 'stat' }, h('b', { text: v }), h('small', { text: l }));
        const sleeping = m.tabs.filter((x) => x.sleeping).length;
        stats.replaceChildren(
          stat(`${m.total.toLocaleString(lang)} MB`, t('Toplam bellek')),
          stat(String(m.tabs.length - sleeping), t('Etkin sekme')),
          stat(String(sleeping), t('Uyuyan sekme')),
          stat(`${(m.gpu + m.browser + m.ui).toLocaleString(lang)} MB`, t('Tarayıcı + GPU + arayüz'))
        );
        rows.replaceChildren(
          ...m.tabs.slice(0, 40).map((x) =>
            h(
              'div',
              { class: 'memrow' },
              h('span', { class: 'fi' }, favEl(x.favicon, '', x.title)),
              h('span', { class: 't', text: x.title }),
              x.sleeping ? h('span', { class: 'zz', text: t('uyuyor') }) : null,
              h('span', { class: 'mb', text: x.sleeping ? '0 MB' : `${x.mb.toLocaleString(lang)} MB${x.shared ? ' *' : ''}` }),
              !x.sleeping && !x.active && x.own ? h('button', { class: 'btn small', onclick: () => cmd('tab.sleep', { tabId: x.id }).then(refresh) }, t('Uyut')) : h('span', { style: { width: '62px' } })
            )
          )
        );
      });
    refresh();
    memTimer = setInterval(() => {
      if (S && S.panel === 'settings' && settingsSection === 'performance') refresh();
    }, 2500);
    return [
      group(
        'Bellek',
        row('Sekme uyutma', 'Bir süre bakmadığınız sekmeler RAM\'i boşaltır; tıklayınca kaldığı yerden açılır. Ses çalan sekmeler ve sık kullanılanlar uyutulmaz.', seg('tabSleepMinutes', [[0, 'Kapalı'], [5, '5 dk'], [15, '15 dk'], [30, '30 dk'], [60, '1 sa'], [120, '2 sa']])),
        row('Bellek tasarrufu', 'Yedek sayfa işlemi hazır tutulmaz (yaklaşık 30–60 MB tasarruf). Yeniden başlatma gerekir.', toggle('memorySaver')),
        row('Otomatik sekme arşivi', 'Uzun süre açılmayan günlük sekmeler kapanır (Ctrl+Shift+T ile geri gelir).', seg('autoArchiveHours', [[0, 'Asla'], [12, '12 saat'], [24, '1 gün'], [168, '1 hafta']]))
      ),
      group(
        'Akıcılık',
        row('Kaydırma', 'Akıcı: Firefox/Edge gibi yumuşak, momentumlu kaydırma. Yeniden başlatma gerekir.', seg('smoothScroll', [['fluid', 'Akıcı'], ['standard', 'Standart'], ['off', 'Kapalı']])),
        row('GPU ile çizim', 'Sayfaları ekran kartıyla çizer; Shorts/Reels gibi kaydırmalı videolarda takılmayı azaltır. Yeniden başlatma gerekir.', toggle('gpuRaster'))
      ),
      group('Şu anki bellek kullanımı', stats, rows),
      h('small', { class: 'group-title', text: t('* Aynı siteden açılan sekmeler tek bir işlemi paylaşabilir.') })
    ];
  }

  function secDownloads() {
    const pathEl = h('small');
    panelSyncs.push(() => {
      pathEl.textContent = S.settings.downloadDir || t('Varsayılan: İndirilenler klasörü');
    });
    return [
      group(
        null,
        h(
          'div',
          { class: 'setting' },
          h('div', { class: 'txt' }, h('b', { text: t('Konum') }), pathEl),
          h('button', { class: 'btn small', onclick: () => cmd('app.openDownloadDir') }, t('Aç')),
          h('button', { class: 'btn small', onclick: () => cmd('app.chooseDownloadDir') }, t('Değiştir…'))
        ),
        row('Her indirmede nereye kaydedileceğini sor', null, toggle('askDownload'))
      ),
      h('p', { class: 'group-title', text: t('Güvenlik: İndirilen dosyalar "internetten geldi" olarak işaretlenir, böylece Windows SmartScreen programları açılmadan önce denetler.') })
    ];
  }

  function secGeneral() {
    return [
      group(
        null,
        row('Dil', null, seg('language', [['auto', 'Sistem'], ['tr', 'Türkçe'], ['en', 'English']])),
        row('Başlangıçta', null, seg('startup', [['restore', 'Kaldığım yerden devam et'], ['fresh', 'Yeni başla']])),
        row('Yazım denetimi', 'Yazı alanlarında yanlış yazılan kelimelerin altını çizer.', toggle('spellcheck')),
        row('Varsayılan tarayıcı', 'Bağlantılar Techin Browser ile açılsın.', h('button', { class: 'btn small', onclick: () => cmd('app.defaultBrowser') }, t('Varsayılan yap'))),
        h(
          'div',
          { class: 'setting' },
          h('div', { class: 'txt' }, h('b', { text: t('Profil konumu') }), h('small', { text: S.meta.userData })),
          h('button', { class: 'btn small', onclick: () => cmd('app.chooseProfileDir') }, t('Taşı…'))
        ),
        row('Ayarları sıfırla', 'Tüm ayarlar varsayılana döner. Sekmeler, geçmiş ve sık kullanılanlar silinmez.', h('button', { class: 'btn small', onclick: () => cmd('settings.reset') }, t('Sıfırla')))
      )
    ];
  }

  function secAbout() {
    const m = S.meta;
    const p = S.protection;
    const wv = m.widevine || {};
    const feat = (ok, title, note) => h('div', { class: 'feat' }, ico(ok ? 'check' : 'x', ok ? 'ok' : 'off'), h('span', { text: t(title) }), note ? h('small', { text: note }) : null);
    const shortcuts = [
      ['Ctrl+T', 'Yeni sekme / komut çubuğu'],
      ['Ctrl+L', 'Adresi düzenle'],
      ['Ctrl+W', 'Sekmeyi kapat'],
      ['Ctrl+Shift+T', 'Kapatılan sekmeyi geri aç'],
      ['Ctrl+Tab', 'Sonraki sekme'],
      ['Ctrl+1…9', 'Sekmeye git'],
      ['Ctrl+D', 'Sık kullanılanlara ekle'],
      ['Ctrl+F', 'Sayfada bul'],
      ['Ctrl+Shift+S', 'Kenar çubuğunu daralt'],
      ['Ctrl+Shift+C', 'Bağlantıyı kopyala'],
      ['Ctrl+Shift+N', 'Gizli pencere'],
      ['Ctrl+H / Ctrl+J', 'Geçmiş / İndirilenler'],
      ['Alt+← / Alt+→', 'Geri / İleri'],
      ['F11', 'Tam ekran'],
      ['F12', 'Geliştirici araçları']
    ];
    return [
      h('div', { class: 'group' }, h('div', { class: 'setting' }, h('img', { src: 'assets/logo.png', alt: '', style: { width: '48px', height: '48px', 'border-radius': '12px' } }), h('div', { class: 'txt' }, h('b', { text: 'Techin Browser ' + m.version }), h('small', { text: t('Chromium tabanlı, hızlı ve gizlilik odaklı tarayıcı') })))),
      group(
        'Sürüm bilgileri',
        h(
          'div',
          { class: 'kv' },
          h('span', { text: 'Chromium' }),
          h('span', { text: m.chrome }),
          h('span', { text: 'Electron' }),
          h('span', { text: m.electron }),
          h('span', { text: 'V8' }),
          h('span', { text: m.v8 }),
          h('span', { text: 'Widevine DRM' }),
          h('span', { text: wv.available ? (wv.version ? `${wv.version} (${wv.status || '—'})` : t('Hazırlanıyor…')) : t('Bu sürümde yok') })
        )
      ),
      group(
        'Güvenlik özellikleri',
        feat(true, 'Her sekme ayrı, korumalı (sandbox) işlemde çalışır'),
        feat(true, 'Site izolasyonu: siteler birbirinin verisine erişemez'),
        feat(S.settings.adblock && p.adblock === 'ready', 'Reklam ve izleyici engelleme', p.rules ? `${p.rules.toLocaleString(lang)} ${t('kural')}` : ''),
        feat(S.settings.malwareProtection && (p.threats.malware > 0 || p.threats.phishing > 0), 'Zararlı ve sahte site koruması'),
        feat(S.settings.httpsOnly, 'Yalnızca HTTPS modu'),
        feat(true, 'İndirilen dosyalar SmartScreen için işaretlenir'),
        feat(true, 'Kamera, mikrofon, konum her site için ayrı izin ister'),
        feat(!!wv.available, 'Netflix, Spotify, Disney+ gibi korumalı içerik (Widevine)')
      ),
      group(
        'Güncellemeler',
        h(
          'div',
          { class: 'setting' },
          h('div', { class: 'txt' }, h('b', { text: t('Sürüm {0}', m.version) }), h('small', { text: updateStatusText() })),
          h('button', { class: 'btn small', onclick: () => cmd('update.check') }, t('Güncellemeleri denetle'))
        )
      ),
      group('Klavye kısayolları', ...shortcuts.map(([k, l]) => h('div', { class: 'feat' }, h('span', { text: t(l) }), h('small', null, h('kbd', { text: k })))))
    ];
  }

  function updateStatusText() {
    const u = S.update || {};
    switch (u.status) {
      case 'unsupported':
        return t('Otomatik güncelleme yalnızca kurulu sürümde çalışır.');
      case 'checking':
        return t('Denetleniyor…');
      case 'none':
        return t('Techin Browser güncel. Son denetim: {0}', new Date(u.checkedAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }));
      case 'available':
        return t('Yeni sürüm var: {0}', u.version);
      case 'downloading':
        return t('İndiriliyor… %{0}', u.percent);
      case 'ready':
        return t('Güncelleme hazır, yeniden başlatınca kurulur.');
      case 'error':
        return t('Güncelleme indirilemedi: {0}', u.error || '');
      default:
        return t('Yeni sürümler açılışta ve 6 saatte bir otomatik denetlenir.');
    }
  }

  // ---- history panel

  function historySearch() {
    const input = h('input', { placeholder: t('Geçmişte ara'), value: historyQuery, spellcheck: 'false' });
    input.addEventListener(
      'input',
      debounce(() => {
        historyQuery = input.value;
        loadHistory();
      }, 180)
    );
    setTimeout(() => input.focus(), 30);
    return h('label', { class: 'search-box' }, ico('search'), input);
  }

  let historyBox = null;

  function buildHistory() {
    historyBox = h('div', { class: 'inner' });
    const body = h(
      'div',
      { class: 'panel-body' },
      h(
        'div',
        { class: 'panel-scroll' },
        historyBox,
        h('div', { class: 'inner', style: { 'margin-top': '14px' } }, h('div', null, h('button', { class: 'btn small', onclick: () => ((settingsSection = 'privacy'), cmd('panel.open', { name: 'settings' })) }, ico('trash'), t('Tarama verilerini temizle…'))))
      )
    );
    loadHistory();
    return body;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return t('Bugün');
    if (d.toDateString() === y.toDateString()) return t('Dün');
    return d.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function loadHistory() {
    cmd('history.list', { query: historyQuery }).then((res) => {
      if (!historyBox || !res) return;
      if (!res.items.length) {
        historyBox.replaceChildren(h('div', { class: 'empty' }, ico('history'), historyQuery ? t('Sonuç bulunamadı') : t('Geçmiş boş')));
        return;
      }
      const out = [];
      let lastDay = '';
      for (const it of res.items) {
        const day = dayLabel(it.last);
        if (day !== lastDay) {
          out.push(h('div', { class: 'day', text: day }));
          lastDay = day;
        }
        const r = h(
          'div',
          { class: 'hrow', title: it.url },
          h('span', { class: 'time', text: new Date(it.last).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) }),
          letter(it.url, it.title),
          h('span', { class: 'tt' }, h('b', { text: it.title || it.url }), h('small', { text: hostOf(it.url) })),
          h(
            'button',
            {
              class: 'ib',
              title: t('Geçmişten kaldır'),
              onclick: (e) => {
                e.stopPropagation();
                cmd('history.remove', { url: it.url }).then(loadHistory);
              }
            },
            ico('x')
          )
        );
        r.addEventListener('click', () => cmd('history.open', { url: it.url }));
        r.addEventListener('auxclick', (e) => e.button === 1 && cmd('history.open', { url: it.url, background: true }));
        out.push(r);
      }
      if (res.total > res.items.length) out.push(h('div', { class: 'empty', text: t('ve {0} kayıt daha — aramayı daraltın', res.total - res.items.length) }));
      historyBox.replaceChildren(...out);
    });
  }

  // ---- downloads panel

  function buildDownloads() {
    const inner = h('div', { class: 'inner' });
    panelSyncs.push(() => {
      const items = S.downloads.items;
      if (!items.length) {
        if (!inner.querySelector('.empty')) inner.replaceChildren(h('div', { class: 'empty' }, ico('download'), t('İndirme yok')));
        return;
      }
      if (inner.querySelector('.empty')) inner.replaceChildren();
      reconcile(inner, items, (d) => d.id, () => h('div', { class: 'dl' }), updateDownload, false);
    });
    return h('div', { class: 'panel-body' }, h('div', { class: 'panel-scroll' }, inner));
  }

  function updateDownload(el, d) {
    const ext = (d.filename.match(/\.([^.]{1,5})$/) || ['', ''])[1];
    const live = d.state === 'progressing' || d.state === 'interrupted-live';
    const sig = JSON.stringify([d.state, d.paused, d.received, d.total, d.exists, lang, d.dangerous]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const act = (op, name, title) => h('button', { class: 'ib', title: t(title), onclick: () => cmd('downloads.action', { id: d.id, op }) }, ico(name));
    let status;
    let statusClass = '';
    if (live) {
      const pct = d.total > 0 ? ` — %${Math.floor((d.received / d.total) * 100)}` : '';
      status = d.paused ? t('Duraklatıldı') + ` — ${fmtBytes(d.received)}` : `${fmtBytes(d.received)}${d.total ? ' / ' + fmtBytes(d.total) : ''}${pct}${d.speed ? ` — ${fmtBytes(d.speed)}/s` : ''}`;
    } else if (d.state === 'completed') {
      status = d.exists ? `${fmtBytes(d.total || d.received)} — ${hostOf(d.url) || t('yerel')}` : t('Dosya silinmiş');
      if (d.dangerous && d.exists) {
        status = t('Bu dosya türü bilgisayarınıza zarar verebilir') + ` — ${fmtBytes(d.total || d.received)}`;
        statusClass = 'warn';
      }
    } else if (d.state === 'cancelled') status = t('İptal edildi');
    else status = t('Başarısız oldu');
    const acts = [];
    if (live) {
      acts.push(d.paused ? act('resume', 'play', 'Devam et') : act('pause', 'pause', 'Duraklat'), act('cancel', 'x', 'İptal'));
    } else {
      if (d.state === 'completed' && d.exists) acts.push(act('open', 'external', 'Aç'), act('show', 'folder', 'Klasörde göster'));
      if (d.state !== 'completed') acts.push(act('retry', 'reset', 'Tekrar dene'));
      acts.push(act('remove', 'trash', 'Listeden kaldır'));
    }
    const pbar = live ? h('div', { class: 'pbar' + (d.total > 0 ? '' : ' indet') }, h('i', { style: { width: d.total > 0 ? `${(d.received / d.total) * 100}%` : '30%' } })) : null;
    el.replaceChildren(
      h('div', { class: 'fic' + (d.dangerous ? ' danger' : '') }, d.dangerous ? ico('warn') : ext || ico('file')),
      h('div', { class: 'meta' }, h('b', { class: d.state === 'completed' && !d.exists ? 'gone' : '', text: d.filename }), pbar, h('small', { class: statusClass, text: status })),
      h('div', { class: 'acts' }, acts)
    );
    el.title = d.url;
  }

  // ------------------------------------------------------------ strip (infobar + find)

  let stripKey = null;
  let findInput = null;
  let findCount = null;

  const PERM_PHRASE = {
    camera: 'kamera',
    microphone: 'mikrofon',
    geolocation: 'konum',
    notifications: 'bildirim gönderme',
    midiSysex: 'MIDI cihazları',
    'clipboard-read': 'pano okuma',
    'idle-detection': 'boşta algılama',
    'window-management': 'pencere yönetimi'
  };

  function renderStrip() {
    const bar = S.infobar;
    const findOpen = S.find.open;
    const key = `${lang}|${bar ? bar.id : ''}|${findOpen}`;
    const strip = $('strip');
    if (key !== stripKey) {
      stripKey = key;
      const kids = [];
      if (bar) kids.push(buildInfobar(bar));
      if (findOpen) kids.push(buildFind());
      else findInput = null;
      strip.replaceChildren(...kids);
    }
    if (findInput) {
      if (document.activeElement !== findInput && findInput.value !== S.find.text) findInput.value = S.find.text;
      const f = S.active && S.active.find;
      if (!S.find.text) findCount.textContent = '';
      else if (f) {
        findCount.textContent = f.matches ? `${f.active}/${f.matches}` : t('Sonuç yok');
        findCount.classList.toggle('none', !f.matches);
      }
    }
  }

  function buildInfobar(bar) {
    const respond = (choice) => () => cmd('infobar.respond', { id: bar.id, choice });
    let icon = 'info';
    let msg;
    let buttons;
    if (bar.type === 'permission') {
      icon = bar.perms[0] || 'info';
      const what = bar.perms.map((p) => t(PERM_PHRASE[p] || p)).join(t(' ve '));
      msg = h('span', { class: 'msg' }, h('b', { text: bar.host }), ' ', t('{0} izni istiyor', what));
      buttons = [h('button', { class: 'btn primary small', onclick: respond('allow') }, t('İzin ver')), h('button', { class: 'btn small', onclick: respond('deny') }, t('Engelle'))];
    } else if (bar.type === 'external') {
      icon = 'external';
      msg = h('span', { class: 'msg', title: bar.url }, h('b', { text: (bar.origin || '').replace(/^https?:\/\//, '') }), ' ', t('bilgisayarınızdaki bir uygulamayı açmak istiyor'), h('small', { text: bar.host + ':' }));
      buttons = [h('button', { class: 'btn primary small', onclick: respond('allow') }, t('Uygulamayı aç')), h('button', { class: 'btn small', onclick: respond('deny') }, t('Vazgeç'))];
    } else {
      icon = 'warn';
      msg = h('span', { class: 'msg', text: t('Bu sayfa yanıt vermiyor.') });
      buttons = [h('button', { class: 'btn small', onclick: respond('wait') }, t('Bekle')), h('button', { class: 'btn primary small', onclick: respond('kill') }, t('Sayfayı yeniden başlat'))];
    }
    return h('div', { class: 'bar info' }, h('span', { class: 'ico' }, ico(icon)), msg, buttons, h('button', { class: 'ib', title: t('Kapat'), onclick: respond('dismiss') }, ico('x')));
  }

  function buildFind() {
    findInput = h('input', { placeholder: t('Sayfada bul'), spellcheck: 'false', value: S.find.text });
    findCount = h('span', { class: 'count' });
    const send = debounce(() => cmd('find.query', { text: findInput.value }), 90);
    findInput.addEventListener('input', send);
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cmd('find.query', { text: findInput.value, forward: !e.shiftKey });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cmd('find.close');
      }
    });
    setTimeout(() => {
      findInput.focus();
      findInput.select();
    }, 20);
    return h(
      'div',
      { class: 'bar find' },
      ico('search'),
      findInput,
      findCount,
      h('button', { class: 'ib', title: t('Önceki (Shift+Enter)'), onclick: () => cmd('find.query', { text: findInput.value, forward: false }) }, ico('chevronDown', 'flip')),
      h('button', { class: 'ib', title: t('Sonraki (Enter)'), onclick: () => cmd('find.query', { text: findInput.value, forward: true }) }, ico('chevronDown')),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'ib', title: t('Kapat (Esc)'), onclick: () => cmd('find.close') }, ico('x'))
    );
  }

  // ------------------------------------------------------------ modals

  let modalKey = null;

  function renderModal() {
    const m = S.modal;
    const key = m ? `${m.type === 'update' && S.update ? S.update.status : ''}|${m.type}|${m.mode || ''}|${m.data && m.data.id ? m.data.id : ''}|${lang}` : null;
    if (key === modalKey) return;
    modalKey = key;
    const box = $('modal');
    box.replaceChildren();
    if (!m) return;
    const builders = { palette: buildPalette, siteinfo: buildSiteInfo, picker: buildPicker, auth: buildAuth, space: buildSpace, update: buildUpdate };
    const el = (builders[m.type] || (() => null))(m);
    if (el) box.append(el);
  }

  const closeModal = (result) => cmd('modal.close', result ? { result } : {});
  $('dim').addEventListener('mousedown', () => closeModal());

  function centerIn(el, width, topRatio = 0.14) {
    const c = S.layout.content;
    const w = Math.min(width, S.layout.W - 32);
    const left = Math.max(16, Math.min(S.layout.W - w - 16, c.x + c.width / 2 - w / 2));
    el.style.setProperty('left', `${left}px`);
    el.style.setProperty('top', `${Math.round(c.y + Math.max(36, c.height * topRatio))}px`);
  }

  // ---- command bar
  function buildPalette(m) {
    const input = h('input', { placeholder: m.mode === 'edit' ? t('Adres yaz veya ara…') : t('Ara, adres yaz veya komut çalıştır…'), spellcheck: 'false', value: m.text || '' });
    const ghost = h('div', { class: 'ghost' });
    const list = h('div', { class: 'results' });
    const foot = h(
      'div',
      { class: 'foot' },
      h('span', null, h('kbd', { text: '↵' }), t('Aç')),
      h('span', null, h('kbd', { text: 'Alt ↵' }), t('Yeni sekmede')),
      h('span', null, h('kbd', { text: '↑↓' }), t('Seç')),
      h('span', null, h('kbd', { text: 'Esc' }), t('Kapat'))
    );
    const box = h('div', { class: 'pop palette' }, h('div', { class: 'inrow' }, ico('search'), h('div', { class: 'field' }, ghost, input)), list, foot);
    centerIn(box, 640);
    let local = [];
    let sugg = [];
    let results = [];
    let sel = 0;
    let seq = 0;
    let noInline = false;

    function iconFor(r) {
      if (r.type === 'tab' || r.type === 'item' || r.type === 'history' || (r.type === 'url' && r.inline)) return favEl(r.favicon, r.url, r.title);
      if (r.type === 'search' || r.type === 'suggest') return ico('search');
      if (r.type === 'url') return ico('globe');
      return ico(r.icon || 'sparkle');
    }

    function draw() {
      list.replaceChildren(
        ...results.map((r, i) => {
          let title = r.title || '';
          let sub = '';
          let tag = '';
          if (r.type === 'search') {
            title = r.text;
            sub = t('{0} ile ara', r.engine);
          } else if (r.type === 'suggest') title = r.text;
          else if (r.type === 'url') {
            title = r.inline ? r.completion : r.url;
            sub = r.inline ? r.title : '';
            tag = t('Siteye git');
          } else if (r.type === 'tab') {
            sub = hostOf(r.url);
            tag = t('Sekmeye geç');
          } else if (r.type === 'item') {
            sub = hostOf(r.url);
            tag = t('Sabit');
          } else if (r.type === 'history') {
            title = r.title || r.url;
            sub = r.url.replace(/^https?:\/\/(www\.)?/, '');
          } else if (r.type === 'action') tag = t('Komut');
          const el = h('div', { class: 'res' + (i === sel ? ' sel' : '') }, h('span', { class: 'fi' }, iconFor(r)), h('span', { class: 'tt' }, h('b', { text: title }), sub ? h('small', { text: sub }) : null), tag ? h('span', { class: 'tag', text: tag }) : null);
          el.addEventListener('mousemove', () => {
            if (sel !== i) {
              sel = i;
              for (const [j, c] of [...list.children].entries()) c.classList.toggle('sel', j === i);
            }
          });
          el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            submit(r, e.altKey || e.button === 1);
          });
          return el;
        })
      );
      drawGhost();
    }

    function drawGhost() {
      const first = results[0];
      const v = input.value;
      if (first && first.inline && !noInline && input.selectionStart === v.length && first.completion.startsWith(v.toLowerCase().replace(/^www\./, ''))) {
        const rest = first.completion.slice(v.toLowerCase().replace(/^www\./, '').length);
        ghost.replaceChildren(h('span', { text: v }), h('em', { text: rest }));
      } else ghost.replaceChildren();
    }

    function merge() {
      const inlineOk = !noInline;
      const base = local.filter((r) => inlineOk || !r.inline);
      const at = Math.max(0, base.findIndex((r) => r.type === 'search') + 1) || Math.min(1, base.length);
      const seen = new Set(base.filter((r) => r.type === 'search').map((r) => r.text.toLowerCase()));
      results = [...base.slice(0, at), ...sugg.filter((s) => !seen.has(s.text.toLowerCase())), ...base.slice(at)];
      sel = Math.min(sel, Math.max(0, results.length - 1));
      draw();
    }

    const suggest = debounce((q, my) => {
      cmd('palette.suggest', { text: q }).then((res) => {
        if (my !== seq) return;
        sugg = res || [];
        merge();
      });
    }, 110);

    function query() {
      const q = input.value;
      const my = ++seq;
      sel = 0;
      cmd('palette.query', { text: q }).then((res) => {
        if (my !== seq) return;
        local = res || [];
        if (!q.trim()) sugg = [];
        merge();
      });
      if (q.trim().length > 1) suggest(q, my);
      else sugg = [];
    }

    function submit(r, newTab = false) {
      const pick = r || { type: 'text', text: input.value };
      if (!pick || (pick.type === 'text' && !pick.text.trim())) return;
      cmd('palette.submit', { pick, newTab });
    }

    input.addEventListener('input', (e) => {
      noInline = e.inputType && e.inputType.startsWith('delete');
      query();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && !results[0]?.inline)) {
        e.preventDefault();
        sel = (sel + 1) % Math.max(1, results.length);
        draw();
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        sel = (sel - 1 + results.length) % Math.max(1, results.length);
        draw();
      } else if (e.key === 'Tab' && results[0]?.inline && !noInline) {
        e.preventDefault();
        input.value = results[0].completion;
        query();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey && /^[\p{L}\p{N}-]+$/u.test(input.value.trim())) return submit({ type: 'text', text: `www.${input.value.trim()}.com` }, e.altKey);
        submit(results[sel] || null, e.altKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    });
    input.addEventListener('keyup', drawGhost);
    input.addEventListener('click', drawGhost);
    requestAnimationFrame(() => {
      input.focus();
      if (m.mode === 'edit') input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    });
    query();
    return box;
  }

  // ---- site info
  function buildSiteInfo(m) {
    const d = m.data;
    const secure = d.security === 'secure';
    const box = h('div', { class: 'pop siteinfo' });
    const anchor = $('btn-siteinfo').getBoundingClientRect();
    box.style.setProperty('left', `${Math.round(Math.max(10, Math.min(S.layout.W - 350, anchor.left + anchor.width / 2 - 170)))}px`);
    box.style.setProperty('top', `${Math.round(anchor.bottom + 8)}px`);
    const statusTitle = { secure: t('Bağlantı güvenli'), insecure: t('Bağlantı güvenli değil'), 'cert-error': t('Sertifika geçersiz'), file: t('Yerel dosya'), local: t('Yerel ağ') }[d.security] || t('Site bilgisi');
    const statusText = secure ? t('Bu siteye gönderdiğiniz bilgiler (şifreler, kart numaraları) şifrelenir.') : d.security === 'insecure' ? t('Bu siteye şifre veya kart bilgisi girmeyin; bilgiler başkaları tarafından görülebilir.') : '';
    box.append(h('div', { class: 'hd' }, h('span', { class: 'ico' + (secure || d.security === 'file' || d.security === 'local' ? '' : ' bad') }, ico(secure ? 'lock' : 'warn')), h('div', null, h('b', { text: statusTitle }), h('small', { text: d.host || d.url }))));
    const sect = (title, ...kids) => h('div', { class: 'sect' }, title ? h('h4', { text: title }) : null, ...kids);
    const info = [];
    if (statusText) info.push(h('div', { class: 'small', text: statusText }));
    if (d.cert && secure) {
      info.push(h('div', { class: 'small', text: t('Sertifikayı veren: {0}', d.cert.issuer) }));
      if (d.cert.validExpiry) info.push(h('div', { class: 'small', text: t('Geçerlilik sonu: {0}', new Date(d.cert.validExpiry * 1000).toLocaleDateString(lang)) }));
    }
    if (d.certBypassed) info.push(h('div', { class: 'small', text: t('Bu site için sertifika uyarısını geçtiniz.') }));
    if (info.length) box.append(sect(null, ...info));
    if (d.origin) {
      const perms = ['camera', 'microphone', 'geolocation', 'notifications', ...Object.keys(d.perms).filter((p) => !['camera', 'microphone', 'geolocation', 'notifications'].includes(p))];
      const rows = perms.map((p) => {
        const s = h('select', null, h('option', { value: 'ask', text: t('Sor') }), h('option', { value: 'allow', text: t('İzin ver') }), h('option', { value: 'deny', text: t('Engelle') }));
        s.value = d.perms[p] || 'ask';
        s.addEventListener('change', () => cmd('site.permission', { origin: d.origin, perm: p, value: s.value }));
        return h('div', { class: 'prow' }, ico(p), h('span', { text: t(PERM_NAMES[p] || p) }), s);
      });
      box.append(sect(t('İzinler'), ...rows));
      const adToggle = h('input', { type: 'checkbox', checked: !d.adblockOff });
      adToggle.addEventListener('change', () => cmd('site.adblock', { host: d.host, enabled: adToggle.checked }).then(() => closeModal()));
      if (d.adblock) {
        box.append(
          sect(
            t('Koruma'),
            h('div', { class: 'prow' }, ico('shieldCheck'), h('span', { text: d.adblockOff ? t('Engelleyici bu sitede kapalı') : t('{0} reklam/izleyici engellendi', d.blocked) }), h('label', { class: 'switch' }, adToggle, h('span')))
          )
        );
      }
      box.append(sect(t('Veriler'), h('div', { class: 'prow' }, ico('cookie'), h('span', { text: t('{0} çerez', d.cookies) }), h('button', { class: 'btn small', onclick: () => cmd('site.clearData', { origin: d.origin }) }, t('Temizle')))));
    }
    return box;
  }

  // ---- update prompt
  function buildUpdate() {
    const u = S.update || {};
    const box = h('div', { class: 'pop dialog update-dialog' });
    const title = u.status === 'ready' ? t('Güncelleme hazır') : t('Yeni güncelleme var');
    const lines = [h('h3', null, ico(u.status === 'ready' ? 'check' : 'download'), title)];
    lines.push(h('p', { text: t('Techin Browser {0} yayınlandı (şu an {1} kullanıyorsunuz).', u.version || '?', u.current || '?') }));
    if (u.notes) lines.push(h('div', { class: 'notes', text: u.notes }));
    if (u.status === 'available') {
      lines.push(h('p', { text: t('İndirmek ister misiniz? İndirme arka planda olur, gezinmeye devam edebilirsiniz.') }));
      lines.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('Sonra')), h('button', { class: 'btn primary', onclick: () => cmd('update.download') }, ico('download'), t('İndir'))));
    } else if (u.status === 'downloading') {
      lines.push(h('div', { class: 'upbar' }, h('i', { style: { width: `${u.percent || 0}%` } })));
      lines.push(h('p', { text: t('İndiriliyor… %{0}', u.percent || 0) }));
      lines.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('Arka planda devam et'))));
    } else if (u.status === 'ready') {
      lines.push(h('p', { text: t('Tarayıcı yeniden başlayınca güncelleme kurulur; sekmeleriniz geri gelir.') }));
      lines.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('Kapatınca kur')), h('button', { class: 'btn primary', onclick: () => cmd('update.install') }, ico('reset'), t('Şimdi yeniden başlat'))));
    } else if (u.status === 'error') {
      lines.push(h('p', { class: 'warnline', text: t('Güncelleme indirilemedi: {0}', u.error || '') }));
      lines.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('Kapat')), h('button', { class: 'btn primary', onclick: () => cmd('update.check') }, t('Tekrar dene'))));
    } else {
      lines.push(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('Kapat'))));
    }
    box.append(...lines);
    centerIn(box, 440, 0.16);
    return box;
  }

  // ---- screen share picker
  function buildPicker(m) {
    const d = m.data;
    let tab = 'screen';
    let chosen = null;
    const grid = h('div', { class: 'grid' });
    const audio = h('input', { type: 'checkbox', checked: d.audio });
    const shareBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => chosen && closeModal({ id: chosen, audio: audio.checked }) }, t('Paylaş'));
    const segEl = h('div', { class: 'seg' });
    const draw = () => {
      segEl.replaceChildren(
        ...[
          ['screen', 'Tüm ekran'],
          ['window', 'Pencere']
        ].map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => ((tab = k), draw()) }, t(l)))
      );
      grid.replaceChildren(
        ...d.sources
          .filter((s) => (tab === 'screen') === s.screen)
          .map((s) => {
            const el = h('button', { class: 'src' + (chosen === s.id ? ' on' : '') }, s.thumb ? h('img', { src: s.thumb, alt: '' }) : h('div', { class: 'noimg' }), h('span', { text: s.name }));
            el.addEventListener('click', () => {
              chosen = s.id;
              shareBtn.disabled = false;
              draw();
            });
            el.addEventListener('dblclick', () => closeModal({ id: s.id, audio: audio.checked }));
            return el;
          })
      );
    };
    draw();
    const box = h(
      'div',
      { class: 'pop picker' },
      h('div', { class: 'dialog', style: { padding: '0', width: 'auto' } }, h('h3', null, ico('screen'), t('{0} ekranınızı görmek istiyor', (d.origin || '').replace(/^https?:\/\//, ''))), h('p', { text: t('Paylaşmak istediğiniz ekranı ya da pencereyi seçin.') })),
      segEl,
      grid,
      h('div', { class: 'dialog', style: { padding: '0', width: 'auto' } }, h('div', { class: 'actions' }, d.audio ? h('label', { class: 'chip2', style: { 'margin-right': 'auto' } }, audio, ' ', t('Sistem sesini de paylaş')) : null, h('button', { class: 'btn', onclick: () => closeModal() }, t('İptal')), shareBtn))
    );
    centerIn(box, 720, 0.08);
    return box;
  }

  // ---- HTTP auth
  function buildAuth(m) {
    const d = m.data;
    const user = h('input', { autocomplete: 'username', spellcheck: 'false' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const submit = () => closeModal({ user: user.value, pass: pass.value });
    for (const i of [user, pass]) {
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') closeModal();
      });
    }
    const box = h(
      'div',
      { class: 'pop dialog' },
      h('h3', null, ico('key'), d.proxy ? t('Proxy oturum açma') : t('Oturum açın')),
      h('p', { text: t('{0} kullanıcı adı ve şifre istiyor.', d.host) + (d.realm ? ` (${d.realm})` : '') }),
      !d.secure ? h('div', { class: 'warnline' }, ico('warn'), t('Bu siteyle bağlantınız gizli değil.')) : null,
      h('label', { class: 'field' }, t('Kullanıcı adı'), user),
      h('label', { class: 'field' }, t('Şifre'), pass),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('İptal')), h('button', { class: 'btn primary', onclick: submit }, t('Oturum aç')))
    );
    centerIn(box, 400, 0.18);
    requestAnimationFrame(() => user.focus());
    return box;
  }

  // ---- space editor
  const EMOJIS = ['', '🏠', '💼', '🎮', '🎵', '📚', '🛒', '✈️', '🎨', '💻', '🧪', '📰', '🍿', '🌙', '⭐', '🔥', '🌿', '⚽', '💬', '🎓'];

  function buildSpace(m) {
    const d = m.data;
    let hue = d.hue;
    let emoji = d.icon || '';
    const name = h('input', { value: d.name || '', placeholder: t('ör. İş, Okul, Oyun'), spellcheck: 'false', maxlength: '40' });
    const preview = h('div', { class: 'hue-preview' });
    const slider = h('input', { type: 'range', class: 'hue', min: '0', max: '359', value: String(hue) });
    const emojis = h('div', { class: 'emojis' });
    const paint = () => {
      const dark = root.dataset.mode === 'dark';
      preview.style.setProperty('background', dark ? `linear-gradient(135deg, hsl(${hue} 36% 16%), hsl(${(hue + 32) % 360} 40% 26%))` : `linear-gradient(135deg, hsl(${hue} 62% 86%), hsl(${(hue + 32) % 360} 56% 76%))`);
      preview.style.setProperty('color', dark ? '#eef2f8' : `hsl(${hue} 32% 16%)`);
      preview.textContent = `${emoji ? emoji + '  ' : ''}${name.value || t('Yeni alan')}`;
      for (const b of emojis.children) b.classList.toggle('on', b.dataset.e === emoji);
    };
    for (const e of EMOJIS) {
      const b = h('button', { title: e || t('Simge yok') }, e || '∅');
      b.dataset.e = e;
      b.addEventListener('click', () => {
        emoji = e;
        paint();
      });
      emojis.append(b);
    }
    slider.addEventListener('input', () => {
      hue = Number(slider.value);
      paint();
    });
    name.addEventListener('input', paint);
    const save = () => cmd('space.save', { id: d.id, name: name.value.trim(), icon: emoji, hue });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') closeModal();
    });
    paint();
    const box = h(
      'div',
      { class: 'pop dialog' },
      h('h3', null, ico('space'), d.id ? t('Alanı düzenle') : t('Yeni alan')),
      preview,
      h('label', { class: 'field' }, t('Ad'), name),
      h('label', { class: 'field' }, t('Simge'), emojis),
      h('label', { class: 'field' }, t('Renk'), slider),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, t('İptal')), h('button', { class: 'btn primary', onclick: save }, t('Kaydet')))
    );
    centerIn(box, 400, 0.12);
    requestAnimationFrame(() => name.focus());
    return box;
  }

  // ------------------------------------------------------------ toasts & events

  function toast(text, iconName) {
    const el = h('div', { class: 'toast' }, ico(iconName || 'info'), h('span', { text }));
    $('toasts').replaceChildren(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  T.onEvent((name, data) => {
    if (name === 'toast') toast(data.text, data.icon);
    else if (name === 'find-focus' && findInput) {
      findInput.focus();
      findInput.select();
    } else if (name === 'settings-section') {
      settingsSection = data.id;
      panelKey = null;
      if (S && S.panel === 'settings') renderPanel();
    } else if (name === 'rename-item') startRename(data.id);
    else if (name === 'download-started') {
      const b = $('btn-downloads');
      b.classList.remove('bounce');
      void b.offsetWidth;
      b.classList.add('bounce');
    } else if (name === 'modal-open') {
      const i = $('modal').querySelector('input');
      if (i) i.focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!S) return;
    if (e.key === 'Escape') {
      if (S.modal) return closeModal();
      if (S.find.open && document.activeElement === findInput) return cmd('find.close');
      if (S.panel) return cmd('panel.close');
    }
    // Typing on the start page goes straight into the command bar.
    const onStart = !S.active && !S.panel && !S.modal;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (onStart && !typing && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && e.key.trim()) {
      e.preventDefault();
      cmd('palette.open', { mode: 'new', text: e.key });
    }
  });

  // ------------------------------------------------------------ main render

  function render() {
    if (!S) return;
    lang = S.lang;
    applyTheme();
    applyLayout();
    if (lang !== lastLang) {
      lastLang = lang;
      translateStatic();
      stripKey = null;
      modalKey = null;
      panelKey = null;
      errorKey = null;
      startBuilt = false;
    }
    renderTop();
    renderUrlbar();
    renderFavorites();
    renderSpaceHead();
    renderLists();
    renderStatus();
    renderFoot();
    renderContent();
    renderStrip();
    renderModal();
  }

  T.onState((state) => {
    S = state;
    render();
  });
  cmd('ui.ready');
})();
