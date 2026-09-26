'use strict';
// End-to-end self test: `npm run selftest` (uses a throwaway profile).
// Starts a local test web server, drives a real window and checks security,
// DRM, tab sleeping, permissions, downloads, crash recovery and more.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { app, desktopCapturer } = require('electron');
const palette = require('./palette');

const OUT_DIR = process.env.TECHIN_SELFTEST_OUT || path.join(os.tmpdir(), 'techin-selftest-out');
const NET = !process.argv.includes('--offline');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(step);
  }
  return null;
}

function startServer() {
  const pages = {
    '/': '<!doctype html><title>Test Page</title><h1>Techin Test</h1><p>Hello Test world</p><a id="l" href="/second" target="_blank">x</a>',
    '/second': '<!doctype html><title>Second</title><p>second</p>',
    '/a': '<!doctype html><title>A</title><p>A</p>',
    '/tall': '<!doctype html><title>Tall</title><body style="margin:0;height:6000px;background:linear-gradient(#fff,#ccd)"><p>tall</p></body>',
    '/b': '<!doctype html><title>B</title><p>B</p>',
    // Google's public Widevine test stream + license proxy, played with Shaka Player.
    '/drm':
      '<!doctype html><title>DRM</title><video id="v" width="640" muted></video><pre id="log"></pre><script src="https://cdn.jsdelivr.net/npm/shaka-player@4/dist/shaka-player.compiled.js"></script><script>const log=(m)=>(document.getElementById("log").textContent+=m+"\\n");shaka.polyfill.installAll();const p=new shaka.Player();p.attach(document.getElementById("v")).then(()=>{p.configure({drm:{servers:{"com.widevine.alpha":"https://cwip-shaka-proxy.appspot.com/no_auth"}}});return p.load("https://storage.googleapis.com/shaka-demo-assets/sintel-widevine/dash.mpd")}).then(()=>log("loaded "+p.keySystem())).catch((e)=>log("ERR "+e.code));</script>',
    '/long': '<!doctype html><title>Long</title><style>body{margin:0;font:18px system-ui}section{height:100vh;display:grid;place-items:center;scroll-snap-align:start}html{scroll-snap-type:y mandatory}</style>' + Array.from({ length: 6 }, (_, i) => `<section style="background:hsl(${i * 60} 60% 60%)">Short ${i + 1}</section>`).join('')
  };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/file.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="test-download.bin"' });
      return res.end(Buffer.alloc(64 * 1024, 7));
    }
    if (url.startsWith('/update/')) {
      // Fake release feed for the updater test (random bytes, correct sha512).
      const bin = Buffer.alloc(200 * 1024, 42);
      const sha = require('node:crypto').createHash('sha512').update(bin).digest('base64');
      const name = 'Techin-Browser-Setup-9.9.9.exe';
      if (url === '/update/latest.yml') {
        res.writeHead(200, { 'Content-Type': 'text/yaml' });
        return res.end(`version: 9.9.9\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${bin.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '2026-09-25T00:00:00.000Z'\nreleaseNotes: '<p>Yeni üst çubuk ve bölünmüş görünüm</p>'\n`);
      }
      if (url === '/update/' + name) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bin.length });
        return res.end(bin);
      }
      res.writeHead(404);
      return res.end();
    }
    if (url === '/ads') {
      return res.end('<!doctype html><title>Ads</title><script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script><img src="https://www.google-analytics.com/collect?v=1">');
    }
    if (url === '/favicon.ico') {
      res.writeHead(404);
      return res.end();
    }
    const body = pages[url];
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<title>404</title>not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function capture(name) {
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } });
    const src = sources.find((s) => s.name === 'Techin Browser');
    if (!src) return null;
    const file = path.join(OUT_DIR, name + '.png');
    fs.writeFileSync(file, src.thumbnail.toPNG());
    return file;
  } catch {
    return null;
  }
}

async function loaded(tab, ms = 15000) {
  await waitFor(() => tab.alive && !tab.wc.isLoading(), ms);
  await sleep(150);
}

async function run(ctl) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const ok = (name, pass, info = '') => {
    results.push({ name, pass: !!pass, info: String(info ?? '') });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  };
  const t0 = Date.now();
  const { server, base } = await startServer();
  const dlDir = path.join(OUT_DIR, 'downloads');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  ctl.setSetting('downloadDir', dlDir);
  ctl.setSetting('onboarded', true);

  try {
    const w = ctl.newWindow({});
    const uiErrors = [];
    w.uiView.webContents.on('console-message', (e, level, message) => {
      const lvl = e.level ?? level;
      if (lvl === 'error' || lvl === 3) uiErrors.push(e.message ?? message);
    });
    ok('Pencere ve arayüz açıldı', await waitFor(() => w.uiReady, 15000));
    // Keep the test window in front: Windows pauses painting of covered windows.
    w.win.setAlwaysOnTop(true);
    await sleep(600);
    ok('Başlangıç ekran görüntüsü', await capture('01-start'));

    // --- UI isolation
    const ui = await w.uiView.webContents.executeJavaScript('({ r: typeof require, p: typeof process, api: typeof window.techin, k: Object.keys(window.techin).sort().join(",") })');
    ok('Arayüz: Node.js erişimi yok (require/process)', ui.r === 'undefined' && ui.p === 'undefined', `${ui.r}/${ui.p}`);
    ok('Arayüz: yalnızca dar techin API açık', ui.api === 'object' && ui.k === 'cmd,log,onEvent,onState,pathForFile', ui.k);

    // --- basic navigation
    const tab = w.openUrl(base + '/', { newTab: true });
    await loaded(tab);
    ok('Yerel sayfa yüklendi', tab.title === 'Test Page', tab.title);

    const sb = await tab.wc.executeJavaScript('[typeof require, typeof process, typeof window.techin, typeof module].join(",")');
    ok('Sekme: sandbox — Node/Electron API yok', sb === 'undefined,undefined,undefined,undefined', sb);

    const ua = await tab.wc.executeJavaScript('navigator.userAgent');
    ok('User-Agent Chrome gibi (Electron izi yok)', /Chrome\/\d+\.0\.0\.0 Safari/.test(ua) && !/Electron|techin/i.test(ua), ua);

    const cs = await tab.wc.executeJavaScript('window.isSecureContext && crossOriginIsolated === false');
    ok('Yerel sayfa güvenli bağlamda', cs === true);

    // --- IPC must reject page senders
    const ipcBlocked = await tab.wc.executeJavaScript('typeof window.ipcRenderer === "undefined" && typeof window.techin === "undefined"');
    ok('Sayfa, tarayıcının iç kanalına erişemiyor', ipcBlocked);

    // --- window.open -> new tab (keeps opener)
    const before = w.tabs.size;
    await tab.wc.executeJavaScript("document.getElementById('l').click(); true", true);
    ok('target=_blank bağlantısı yeni sekmede açıldı', await waitFor(() => w.tabs.size === before + 1, 5000), `${w.tabs.size} sekme`);
    const child = [...w.tabs.values()].find((t) => t.openerId === tab.id);
    if (child) await loaded(child);
    ok('Yeni sekme doğru sayfayı gösteriyor', child && child.title === 'Second', child && child.title);

    // --- popup windows (sign-in style)
    w.activateTab(tab.id);
    await tab.wc.executeJavaScript(`window.__p = window.open('${base}/second', 'login', 'width=420,height=360'); true`, true);
    ok('Boyutlu window.open ayrı açılır pencere oluşturdu', await waitFor(() => ctl.popups.size === 1, 5000));
    const opener = await waitFor(async () => {
      const p = [...ctl.popups.values()][0];
      return p && (await p.wc.executeJavaScript('window.opener !== null'));
    }, 5000);
    ok('Açılır pencere opener bağlantısını koruyor (Google ile giriş vb.)', opener);
    await tab.wc.executeJavaScript('window.__p.close(); true', true);
    ok('Açılır pencere kapandı', await waitFor(() => ctl.popups.size === 0, 5000));

    // --- permissions prompt
    await tab.wc.executeJavaScript('navigator.geolocation.getCurrentPosition(() => {}, () => {}); true', true);
    const bar = await waitFor(() => w.infobars.find((b) => b.type === 'permission'), 5000);
    ok('Konum izni sorulan çubuk açıldı (sessizce verilmedi)', bar, bar && bar.perms.join(','));
    if (bar) w.respondInfobar(bar.id, 'deny');
    ok('Engelleme kararı site için kaydedildi', ctl.getSitePermission(base, 'geolocation', false) === 'deny');
    const permState = await tab.wc.executeJavaScript("navigator.permissions.query({name:'geolocation'}).then(r => r.state)");
    ok('Sayfa artık izni "denied" görüyor', permState === 'denied', permState);
    ctl.setSitePermission(base, 'geolocation', 'ask', false);

    // --- external protocol prompt
    await tab.wc.executeJavaScript("location.href = 'mailto:test@example.com'; true", true);
    const ext = await waitFor(() => w.infobars.find((b) => b.type === 'external'), 5000);
    ok('Harici uygulama (mailto:) açmadan önce soruldu', ext, ext && ext.url);
    if (ext) w.respondInfobar(ext.id, 'deny');
    await tab.wc.executeJavaScript("location.href = 'ms-msdt:/id PCWDiagnostic'; true", true).catch(() => {});
    await sleep(500);
    ok('Tehlikeli protokol (ms-msdt, Follina) sormadan reddedildi', !w.infobars.some((b) => b.type === 'external'));

    // --- find in page
    w.openFind();
    w.findQuery({ text: 'Test', newSession: true });
    const found = await waitFor(() => tab.findResult && tab.findResult.matches >= 1, 5000);
    ok('Sayfada bul çalışıyor', found, tab.findResult && JSON.stringify(tab.findResult));
    w.closeFind();

    // --- palette
    w.openPalette('new');
    ok('Komut çubuğu açıldı, arayüz sayfanın üstünde', await waitFor(() => w.modal && w.uiOnTop, 1000, 10));
    const q = palette.query(ctl, w, 'second');
    ok('Komut çubuğu açık sekmeyi buluyor', q.some((r) => r.type === 'tab'), q.map((r) => r.type).join(','));
    const q2 = palette.query(ctl, w, 'ayarlar');
    ok('Komut çubuğu komutları buluyor', q2.some((r) => r.type === 'action' && r.id === 'settings'));
    await sleep(400);
    await capture('02-palette');
    w.closeModal();
    ok('Komut çubuğu kapandı, sayfa yeniden üstte', !w.modal && !w.uiOnTop);

    // --- back/forward history survives sleep
    tab.load(base + '/a');
    await loaded(tab);
    tab.load(base + '/b');
    await loaded(tab);
    const other = w.createTab({ url: base + '/second' });
    await loaded(other);
    ok('Diğer sekmeye geçildi', w.activeTabId === other.id);
    const slept = tab.sleep();
    ok('Arka plan sekmesi uyutuldu (işlem kapatıldı)', slept && !tab.alive);
    const nav = tab.navState;
    ok('Uyuyan sekme geri/ileri geçmişini tutuyor', nav && nav.entries.length >= 3, nav && nav.entries.length);
    w.activateTab(tab.id);
    await loaded(tab);
    ok('Sekme uyandı ve kaldığı sayfada', tab.alive && tab.url.endsWith('/b'), tab.url);
    ok('Uyanınca "geri" hâlâ çalışıyor', tab.wc.navigationHistory.canGoBack());

    // --- crash recovery
    tab.wc.forcefullyCrashRenderer();
    ok('Çöken sekme algılandı', await waitFor(() => tab.crashed, 5000), String(tab.crashed));
    ok('Çökme diğer sekmeleri etkilemedi', other.alive && !other.crashed);
    await capture('03-crash');
    tab.reload();
    await loaded(tab);
    ok('Çöken sekme yeniden yüklendi', tab.alive && !tab.crashed && tab.title === 'B', tab.title);

    // --- malware / phishing block
    ctl.protection.threats.malware.add('malware-test.invalid');
    tab.load('http://malware-test.invalid/payload');
    ok('Zararlı site engellendi ve uyarı gösterildi', await waitFor(() => tab.error && tab.error.kind === 'malware', 8000), tab.error && tab.error.kind);
    await sleep(300);
    await capture('04-malware');
    w.errorAction('back');
    await sleep(300);

    // --- downloads + Mark of the Web
    tab.wc.downloadURL(base + '/file.bin');
    const dl = await waitFor(() => ctl.downloads.items.find((d) => d.filename === 'test-download.bin' && d.state === 'completed'), 10000);
    ok('İndirme tamamlandı', dl, dl && dl.path);
    if (dl) {
      let motw = '';
      try {
        motw = fs.readFileSync(dl.path + ':Zone.Identifier', 'utf8');
      } catch {}
      ok('İndirilen dosya "internetten geldi" (SmartScreen) işaretli', /ZoneId=3/.test(motw), motw.replace(/\r?\n/g, ' | '));
    }
    tab.wc.downloadURL(base + '/file.bin');
    const dl2 = await waitFor(() => ctl.downloads.items.find((d) => d.filename === 'test-download (1).bin'), 10000);
    ok('Aynı adlı dosya üzerine yazılmadı (test-download (1).bin)', dl2);

    // --- Firefox-like smooth wheel (page.js): sample scroll position every frame
    const wheelRun = async (path) => {
      tab.load(base + path);
      await loaded(tab);
      await tab.wc.executeJavaScript('window.__s = []; (function f(){ window.__s.push([performance.now(), Math.round(scrollY)]); if (window.__s.length < 90) requestAnimationFrame(f); })(); true');
      tab.wc.focus();
      tab.wc.sendInputEvent({ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -100, wheelTicksX: 0, wheelTicksY: -1, canScroll: true, hasPreciseScrollingDeltas: false });
      await sleep(1600);
      const s = await tab.wc.executeJavaScript('({ s: window.__s, h: innerHeight })');
      const ys = s.s.map((p) => p[1]);
      const moving = s.s.filter((p, i) => i > 0 && p[1] !== s.s[i - 1][1]);
      const ms = moving.length ? Math.round(moving[moving.length - 1][0] - moving[0][0]) : 0;
      return { final: ys[ys.length - 1], steps: new Set(ys).size, ms, h: s.h };
    };
    const snapRun = await wheelRun('/long');
    ok('Shorts tarzı sayfada tek tekerlek adımı sonraki videoya kayarak geçiyor', Math.abs(snapRun.final - snapRun.h) <= 2 && snapRun.steps >= 10 && snapRun.ms >= 250, JSON.stringify(snapRun));
    const tallRun = await wheelRun('/tall');
    ok('Normal sayfada tekerlek kaydırması yumuşak (Firefox gibi)', tallRun.final >= 90 && tallRun.final <= 110 && tallRun.steps >= 8 && tallRun.ms >= 200, JSON.stringify(tallRun));
    const pk = await tab.wc.executeJavaScript("navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16) } }).then(() => 'resolved', (e) => e.name).then((r) => typeof window.PublicKeyCredential + ' ' + r)");
    ok('Geçiş anahtarı (Windows Hello) penceresi açılmıyor', pk === 'undefined NotAllowedError', pk);
    // --- scroll snapping page (Shorts-like)
    tab.load(base + '/long');
    await loaded(tab);
    const snap = await tab.wc.executeJavaScript('getComputedStyle(document.documentElement).scrollSnapType');
    ok('Kaydırmalı (Shorts tarzı) sayfa yüklendi', /mandatory/.test(snap), snap);

    // --- DRM
    const wv = ctl.meta.widevine || {};
    ok('Widevine bileşeni hazır', wv.available && wv.version, JSON.stringify(wv));
    const eme = await tab.wc.executeJavaScript(`navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'SW_SECURE_CRYPTO' }], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' }] }]).then(a => a.keySystem + ' ok').catch(e => 'ERR ' + e.message)`);
    ok('Sayfalar Widevine DRM kullanabiliyor (Netflix/Spotify için)', /ok$/.test(eme), eme);

    // --- ad blocking
    const ready = await waitFor(() => ctl.protection.blocker, NET ? 60000 : 1000, 200);
    ok('Reklam engelleyici listeleri yüklendi', ready, `${ctl.protection.status.rules} kural`);
    if (ready) {
      const m = ctl.protection.matchRequest({ id: 1, url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', resourceType: 'script', referrer: 'https://example.com/', webContentsId: 0 });
      ok('Reklam betiği (doubleclick) engelleniyor / zararsızlaştırılıyor', m && (m.cancel || m.redirectURL), m && (m.cancel ? 'iptal' : 'boş betiğe yönlendirildi'));
      const clean = ctl.protection.matchRequest({ id: 2, url: 'https://example.com/app.js', resourceType: 'script', referrer: 'https://example.com/', webContentsId: 0 });
      ok('Normal betik engellenmiyor', !clean);
      tab.load(base + '/ads');
      await loaded(tab);
      await sleep(500);
      ok('Sayfadaki reklam/izleyici istekleri sayıldı', tab.blocked >= 1, `${tab.blocked} engellendi`);
    }

    if (NET && process.argv.includes('--drm')) {
      // --- real Widevine playback: Google's protected test stream (license via Widevine servers)
      tab.load(base + '/drm');
      await loaded(tab, 30000);
      const played = await waitFor(
        async () => {
          const s = await tab.wc.executeJavaScript('(() => { const v = document.getElementById("v"); if (v.paused && v.readyState > 2) v.play().catch(() => {}); return { t: v.currentTime, keys: !!v.mediaKeys, w: v.videoWidth, log: document.getElementById("log").textContent }; })()', true);
          return s && s.t > 3 && s.keys ? s : null;
        },
        60000,
        1000
      );
      await capture('12-drm');
      ok('Widevine korumalı video gerçekten oynatıldı (lisans alındı)', played, played ? `${played.t.toFixed(1)} sn oynatıldı, ${played.w}px, mediaKeys aktif` : 'oynatılamadı');
    }

    // --- a local HTML file must not read other local files (the file:// fuse
    // stays on for castlabs VMP signing; security.js blocks fetch between files)
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'techin-file-'));
      fs.writeFileSync(path.join(dir, 'secret.txt'), 'GIZLI');
      fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
      fs.writeFileSync(path.join(dir, 'a.html'), "<!doctype html><title>wait</title><img id=\"i\" src=\"pic.svg\"><script>fetch('secret.txt').then((r) => r.text()).then((t) => { document.title = 'READ:' + t; }).catch(() => { document.title = 'BLOCKED'; });</script>");
      const ft = w.createTab({ url: require('node:url').pathToFileURL(path.join(dir, 'a.html')).href });
      const res = await waitFor(async () => {
        const r = await ft.wc.executeJavaScript("({ title: document.title, img: document.getElementById('i') ? document.getElementById('i').naturalWidth : 0 })").catch(() => null);
        return r && r.title !== 'wait' && r.img ? r : null;
      }, 6000, 150);
      ok('Yerel HTML dosyası diğer yerel dosyaları okuyamıyor (resimler yine yükleniyor)', !!res && res.title === 'BLOCKED' && res.img === 10, JSON.stringify(res));
      ft.close({ force: true });
      w.activateTab(tab.id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }

    if (NET) {
      // --- HTTPS upgrade (network)
      tab.load('http://example.com/');
      await loaded(tab, 20000);
      ok('HTTP adres otomatik HTTPS’e yükseltildi', tab.url.startsWith('https://example.com'), tab.url);
      // --- YouTube with the ad blocker on: Home -> Shorts must play (regression: gray screen)
      {
        const yt = w.createTab({ url: 'https://www.youtube.com/' });
        const ytErrs = [];
        yt.wc.on('console-message', (e, l, m) => {
          const msg = String(e.message ?? m);
          if (/JSONPath|Maximum call stack/.test(msg)) ytErrs.push(msg.slice(0, 100));
        });
        await sleep(7000);
        await yt.wc.executeJavaScript("(() => { const a = [...document.querySelectorAll('ytd-guide-entry-renderer a, ytd-mini-guide-entry-renderer a')].find((x) => /shorts/i.test(x.getAttribute('href') || '')); if (a) a.click(); })()", true).catch(() => {});
        const vid = await waitFor(() => yt.wc.executeJavaScript("(() => { const v = document.querySelector('ytd-shorts video'); return !!v && v.readyState > 2 && location.pathname.startsWith('/shorts'); })()"), 15000, 500);
        ok('Reklam engelleyici açıkken YouTube Shorts açılıp oynuyor (gri ekran yok)', vid && !ytErrs.length, ytErrs.join(' | ') || yt.url);
        if (vid) {
          const shortId = (p) => (typeof p === 'string' && p.length > 14 && p.startsWith('/shorts/') ? p : null);
          const before = await waitFor(async () => shortId(await yt.wc.executeJavaScript('location.pathname')), 8000, 200);
          await sleep(800);
          const pt = await yt.wc.executeJavaScript('(() => { const r = document.getElementById("shorts-container").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
          await yt.wc.executeJavaScript("window.__wp = 'none'; window.addEventListener('wheel', (e) => { window.__wp = e.defaultPrevented; }, { passive: true }); true");
          yt.wc.focus();
          yt.wc.sendInputEvent({ type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -100, wheelTicksX: 0, wheelTicksY: -1, canScroll: true, hasPreciseScrollingDeltas: false });
          const after = await waitFor(async () => { const p = await yt.wc.executeJavaScript('location.pathname'); return p !== before && p; }, 5000, 100);
          if (!after) console.log('SHORTS-DIAG', JSON.stringify(await yt.wc.executeJavaScript('({ active: document.activeElement && (document.activeElement.tagName + "#" + document.activeElement.id), focus: document.hasFocus(), prevented: window.__wp, hover: (document.elementFromPoint(innerWidth / 2, innerHeight / 2) || {}).id, btn: !!document.querySelector("#navigation-button-down button") })')));
          ok('Shorts: tek tekerlek adımı YouTube kendi kayma geçişiyle sonraki videoya geçiyor', !!after, `${before} -> ${after}`);
          // Ambient mode switch in the "..." menu must really turn the glow off
          // (YouTube sends that switch without its toggle actions; page.js adds them).
          await sleep(1500);
          const realClick = async (p) => {
            for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
              yt.wc.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
              await sleep(40);
            }
          };
          const ambient = () => yt.wc.executeJavaScript("(() => { const c = document.querySelector('ytd-shorts')?.polymerController; const cc = c && Object.keys(c).map((k) => c[k]).find((v) => v && typeof v === 'object' && 'settingEnabled' in v && 'prefersReducedMotionQuery' in v); return cc ? cc.settingEnabled : null; })()").catch(() => null);
          const menuAt = await yt.wc.executeJavaScript("(() => { const r = [...document.querySelectorAll('button[aria-haspopup], #menu-button button, button')].filter((x) => /Daha fazla|More actions/i.test(x.getAttribute('aria-label') || '')).map((x) => x.getBoundingClientRect()).find((q) => q.width > 0 && q.top >= 0 && q.bottom <= innerHeight); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()").catch(() => null);
          const was = await ambient();
          if (menuAt && was !== null) {
            await realClick(menuAt);
            const findSwitch = () => yt.wc.executeJavaScript("(() => { const s = [...document.querySelectorAll('yt-list-item-view-model [role=\"switch\"]')].find((x) => x.offsetParent && /Ambi/i.test(x.getAttribute('aria-label') || '')); if (!s) return null; const q = s.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), on: s.getAttribute('aria-checked') === 'true' }; })()").catch(() => null);
            // Two flips (on->off->on or off->on->off): the effect must follow the switch each time.
            const trail = [];
            for (let i = 0; i < 2; i++) {
              if (i > 0) await realClick(menuAt); // the menu closes after a tap
              const sw = await waitFor(findSwitch, 4000, 200);
              if (!sw) break;
              await realClick(sw);
              const want = !sw.on;
              trail.push(`${sw.on}->${(await waitFor(async () => ((await ambient()) === want ? 'ok' : null), 3000, 150)) ? want : await ambient()}`);
              await sleep(600);
            }
            const good = trail.length === 2 && trail.every((s) => s === 'true->false' || s === 'false->true');
            ok('Shorts: "Ambiyans modu" düğmesi efekti gerçekten açıp kapatıyor', good, `başta ${was}; düğme->efekt: ${trail.join(', ')}`);
          } else {
            ok('Shorts: "Ambiyans modu" düğmesi efekti gerçekten açıp kapatıyor', false, `menü ${!!menuAt}, ambiyans ${was}`);
          }
          // Wheel over the open comments panel scrolls the comments, not the videos.
          await sleep(1500);
          const cBtn = await yt.wc.executeJavaScript("(() => { const b = [...document.querySelectorAll('button')].filter((x) => /yorum|comment/i.test(x.getAttribute('aria-label') || '')).map((x) => x.getBoundingClientRect()).find((q) => q.width > 0 && q.top >= 0 && q.bottom <= innerHeight); return b ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } : null; })()").catch(() => null);
          const panelState = () => yt.wc.executeJavaScript("(() => { const p = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')].find((x) => x.offsetParent && /comment/i.test(x.getAttribute('target-id') || x.id || '') && x.getBoundingClientRect().width > 50); if (!p) return null; const r = p.getBoundingClientRect(); const sc = [...p.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)); return sc ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.6), top: Math.round(sc.scrollTop), path: location.pathname } : null; })()").catch(() => null);
          if (cBtn) {
            for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
              yt.wc.sendInputEvent({ type, x: cBtn.x, y: cBtn.y, button: 'left', clickCount: 1 });
              await sleep(40);
            }
          }
          const p0 = await waitFor(panelState, 8000, 250);
          let p1 = null;
          if (p0) {
            for (let i = 0; i < 3; i++) {
              yt.wc.sendInputEvent({ type: 'mouseWheel', x: p0.x, y: p0.y, deltaX: 0, deltaY: -100, wheelTicksX: 0, wheelTicksY: -1, canScroll: true, hasPreciseScrollingDeltas: false });
              await sleep(250);
            }
            await sleep(1200);
            p1 = await panelState();
          }
          ok('Shorts: yorumların üstünde tekerlek yorumları kaydırıyor, video değişmiyor', !!p0 && !!p1 && p1.path === p0.path && p1.top > p0.top, JSON.stringify({ p0, p1 }));
        }
        yt.close({ force: true });
        w.activateTab(tab.id);
      }
      // --- Instagram Reels: one notch = one reel, slid Firefox-like (transform slide)
      {
        const ig = w.createTab({ url: 'https://www.instagram.com/reels/' });
        await sleep(9000);
        const FEED = "[...document.querySelectorAll('div')].find((n) => /y/.test(getComputedStyle(n).scrollSnapType) && n.scrollHeight > n.clientHeight + 100)";
        const pt = await ig.wc.executeJavaScript(`(() => { const f = ${FEED}; if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
        const trail = [];
        if (pt) {
          // down, up, down: stays within the reels Instagram shows before asking to log in
          for (const down of [true, false, true]) {
            const before = await ig.wc.executeJavaScript('location.pathname');
            await ig.wc.executeJavaScript("window.__igT = null; (() => { const f = " + FEED + "; const fr = f.getBoundingClientRect(); let cur = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2); while (cur && cur.parentElement !== f) cur = cur.parentElement; const k = [cur || [...f.children].sort((p, q) => Math.abs(p.getBoundingClientRect().top - fr.top) - Math.abs(q.getBoundingClientRect().top - fr.top))[0]]; let t0 = null; let y0 = null; (function r() { const y = k[0].getBoundingClientRect().top; if (t0 === null && y0 !== null && y !== y0) t0 = performance.now(); if (y0 === null) y0 = y; if (t0 !== null && window.__igT === null && performance.now() - t0 >= 100) window.__igT = Math.round((Math.abs(y - y0) / k[0].getBoundingClientRect().height) * 100); if (t0 === null || performance.now() - t0 < 200) requestAnimationFrame(r); })(); })(); true").catch(() => {});
            ig.wc.focus();
            ig.wc.sendInputEvent({ type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: down ? -100 : 100, wheelTicksX: 0, wheelTicksY: down ? -1 : 1, canScroll: true, hasPreciseScrollingDeltas: false });
            const after = await waitFor(async () => {
              const p = await ig.wc.executeJavaScript('location.pathname').catch(() => before);
              return p !== before ? p : null;
            }, 3000, 100);
            const startMs = await ig.wc.executeJavaScript('window.__igT').catch(() => null);
            trail.push({ down, changed: !!after, pctAt100ms: startMs });
            await sleep(900);
          }
        }
        // Chromium's own snap creeps (~5% of the way after 100 ms of motion); the slide is ~half way.
        // A background window may skip frames and miss one measurement; every one taken must be fast.
        const measured = trail.filter((r) => r.pctAt100ms !== null);
        const good = trail.length === 3 && trail.every((r) => r.changed) && measured.length >= 2 && measured.every((r) => r.pctAt100ms >= 30);
        ok('Instagram Reels: tek tekerlek adımı hızlı başlayıp bir sonraki/önceki reel’e kayıyor', good, JSON.stringify(trail));
        ig.close({ force: true });
        w.activateTab(tab.id);
      }
      // --- Chrome Web Store used to crash the whole browser (webstorePrivate)
      {
        const ws = w.createTab({ url: 'https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh' });
        await loaded(ws, 20000);
        await sleep(4000);
        const st = await ws.wc.executeJavaScript("({ api: typeof chrome !== 'undefined' && !!chrome.webstorePrivate, title: document.title })").catch((e) => ({ err: e.message }));
        ok('Chrome Web Mağazası açılınca tarayıcı çökmüyor', st && st.api === false && !st.err, JSON.stringify(st));
        ws.close({ force: true });
        w.activateTab(tab.id);
      }
      // --- Google sign-in: presented as Firefox only on accounts.google.com
      tab.load('https://accounts.google.com/');
      await loaded(tab, 20000);
      const gua = await tab.wc.executeJavaScript('({ ua: navigator.userAgent, data: typeof navigator.userAgentData })');
      ok('Google giriş sayfasında Firefox kimliği (giriş engeli aşılır)', /Firefox\/\d+/.test(gua.ua) && gua.data === 'undefined', gua.ua + ' / userAgentData: ' + gua.data);
      tab.load('https://example.com/');
      await loaded(tab, 20000);
      const back = await tab.wc.executeJavaScript('navigator.userAgent');
      ok('Diğer sitelerde yeniden Chrome kimliği', /Chrome\/\d+/.test(back) && !/Firefox/.test(back), back);
      // --- certificate errors (network)
      tab.load('https://self-signed.badssl.com/');
      ok('Geçersiz sertifika engellendi ve uyarı gösterildi', await waitFor(() => tab.error && tab.error.kind === 'cert', 20000), tab.error && tab.error.desc);
      await sleep(300);
      await capture('05-cert');
      w.errorAction('back');
      const thr = ctl.protection.counts();
      ok('Zararlı/oltalama listeleri indirildi', thr.malware > 100 && thr.phishing > 100, `${thr.malware} + ${thr.phishing}`);
    }

    // --- close / reopen, shortcuts, spaces, incognito, session restore
    const countBefore = w.tabs.size;
    const closing = w.createTab({ url: base + '/a' });
    await loaded(closing);
    w.closeTab(closing.id);
    ok('Sekme kapatıldı', await waitFor(() => w.tabs.size === countBefore, 5000));
    w.reopenClosed();
    ok('Kapatılan sekme geri açıldı (Ctrl+Shift+T)', await waitFor(() => w.tabs.size === countBefore + 1 && w.activeTab()?.url.endsWith('/a'), 5000));
    w.activeTab().close({ force: true });
    await sleep(200);
    w.activateTab(tab.id);
    ok('Ctrl+T kısayolu komut çubuğunu açıyor', w.handleKey({ type: 'keyDown', control: true, code: 'KeyT', key: 't' }, tab) && w.modal?.type === 'palette');
    w.closeModal();
    ok('Ctrl+Tab sonraki sekmeye geçiyor', w.handleKey({ type: 'keyDown', control: true, code: 'Tab', key: 'Tab' }, tab) && w.activeTabId !== tab.id);
    w.activateTab(tab.id);
    const sp2 = ctl.library.addSpace({ name: 'İş', icon: '💼', hue: 20 });
    w.switchSpace(sp2.id);
    ok('Yeni alana geçildi (boş başlangıç ekranı)', w.activeSpaceId === sp2.id && w.activeTabId === null);
    w.switchSpace(ctl.library.spaces[0].id);
    ok('Eski alana dönünce son sekme geri geldi', w.activeTabId === tab.id);
    await tab.wc.executeJavaScript('document.cookie = "techin_test=1; max-age=600"; true');
    const inc = ctl.newWindow({ incognito: true });
    await waitFor(() => inc.uiReady, 10000);
    const itab = inc.openUrl(base + '/second', { newTab: true });
    await loaded(itab);
    const icookie = await itab.wc.executeJavaScript('document.cookie');
    ok('Gizli pencere çerezleri normal pencereyle paylaşmıyor', !icookie.includes('techin_test'), icookie || '(boş)');
    ok('Gizli pencere geçmişe kaydetmiyor', !ctl.history.items.some((it) => it.url === base + '/second' && it.last > Date.now() - 3000));
    inc.win.close();
    await sleep(300);
    const snapshot = JSON.parse(JSON.stringify(w.serialize()));
    const r = ctl.newWindow({ restore: snapshot });
    await waitFor(() => r.uiReady, 10000);
    await loaded(r.activeTab());
    ok('Oturum geri yüklendi (sekmeler + etkin sekme)', r.tabs.size === w.tabs.size && r.activeTab()?.url === tab.url, `${r.tabs.size}/${w.tabs.size} sekme`);
    ok('Geri yüklenen arka plan sekmeleri uykuda başlıyor (RAM tasarrufu)', [...r.tabs.values()].filter((x) => x.alive).length === 1);
    r.win.close();
    await sleep(300);
    w.win.focus();

    // --- v1.0.1: search words, Arc-style top bar, split view, hidden sidebar, updates
    const sw = w.openUrl('youtube', { newTab: true });
    ok('Tek kelime ("youtube") arama motorunda aranıyor', sw.url.startsWith('https://www.google.com/search?q=youtube'), sw.url);
    sw.close({ force: true });
    await sleep(200);
    w.activateTab(tab.id);
    await sleep(300);
    const tb = await w.uiView.webContents.executeJavaScript(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const close = r('.winctl .close'), copy = r('#btn-copy'), url = r('#urlbar');
      const sb = r('#btn-sidebar'), back = r('#btn-back');
      return { W: innerWidth, closeRight: close.right, closeTop: close.top, copyLeftOfUrl: copy.right <= url.left + 1, navGap: back.left - sb.right, newTabLast: document.getElementById('today').nextElementSibling.id === 'btn-newtab' };
    })()`);
    ok('Kapat düğmesi sağ üst köşede', Math.abs(tb.closeRight - tb.W) < 2 && tb.closeTop < 4, JSON.stringify({ right: tb.closeRight, W: tb.W }));
    ok('Üst çubukta adresin solunda bağlantı kopyalama düğmesi', tb.copyLeftOfUrl);
    ok('Geri/ileri/yenile kenar çubuğu düğmesinin hemen yanında', tb.navGap >= 0 && tb.navGap < 12, `boşluk ${Math.round(tb.navGap)} px`);
    ok('Yeni sekme düğmesi sekme listesinin altında', tb.newTabLast);
    const { clipboard } = require('electron');
    await clipboard.writeText('');
    await w.uiView.webContents.executeJavaScript("document.getElementById('btn-copy').click(); true");
    ok('Kopyala düğmesi sayfa adresini panoya kopyalıyor', await waitFor(async () => (await clipboard.readText()) === tab.url, 3000), await clipboard.readText());
    w.toggleSplit(other.id);
    await sleep(500);
    ok('Bölünmüş görünüm: iki sayfa yan yana', w.shownViews.length === 2 && w.paneRects().length === 2, `${w.shownViews.length} görünüm`);
    const [pa, pb] = w.paneRects();
    ok('Bölünmüş görünüm: yarımlar çakışmıyor', pa.x + pa.width < pb.x && Math.abs(pa.width - pb.width) <= 1);
    await capture('13-split');
    w.toggleSplit();
    ok('Bölünmüş görünüm kapandı', w.shownViews.length === 1 && !w.split);
    ctl.setSetting('sidebarHidden', true);
    await sleep(400);
    ok('Kenar çubuğu gizlenince sayfa genişliyor', w.metrics().sidebar === 0 && w.metrics().content.x === w.metrics().gap);
    await capture('14-sidebar-hidden');
    ctl.setSetting('sidebarHidden', false);
    ctl.updater.useTestFeed(base + '/update/');
    await ctl.updater.check(true);
    ok('Yeni güncelleme bulundu', await waitFor(() => ctl.updater.state.status === 'available', 8000), JSON.stringify({ s: ctl.updater.state.status, v: ctl.updater.state.version, e: ctl.updater.state.error }));
    ok('"Yeni güncelleme var, indirmek ister misiniz?" penceresi açıldı', await waitFor(() => w.modal && w.modal.type === 'update', 3000));
    await sleep(300);
    ok('Üst çubukta "Güncelleme var" düğmesi görünüyor', await w.uiView.webContents.executeJavaScript("!document.getElementById('btn-update').classList.contains('hidden')"));
    await capture('15-update');
    await w.uiView.webContents.executeJavaScript("[...document.querySelectorAll('.update-dialog .btn.primary')].pop().click(); true");
    ok('Güncelleme indirildi ve doğrulandı (sha512)', await waitFor(() => ctl.updater.state.status === 'ready', 15000), JSON.stringify({ s: ctl.updater.state.status, e: ctl.updater.state.error }));
    await sleep(300);
    await capture('16-update-ready');
    w.closeModal();

    // --- UI walkthrough (clicks every settings section, types into the command bar ...)
    const ux = (code) => w.uiView.webContents.executeJavaScript(code);
    w.openPanel('settings');
    await sleep(400);
    const sections = await ux('document.querySelectorAll(".snav button").length');
    let memRows = 0;
    for (let i = 0; i < sections; i++) {
      await ux(`document.querySelectorAll(".snav button")[${i}].click(); true`);
      await sleep(i === 4 ? 900 : 180);
      if (i === 2) await capture('06b-privacy');
      if (i === 4) {
        await capture('06c-performance');
        memRows = await ux('document.querySelectorAll(".memrow").length');
      }
    }
    ok('Tüm ayar bölümleri açıldı', sections === 8, `${sections} bölüm`);
    ok('Performans bölümü sekme belleklerini listeliyor', memRows >= 1, `${memRows} satır`);
    await ux('document.querySelectorAll(".snav button")[0].click(); true');
    await sleep(300);
    await capture('06-settings');
    w.openPanel('history');
    await sleep(400);
    ok('Geçmiş paneli kayıtları gösteriyor', (await ux('document.querySelectorAll(".hrow").length')) >= 1);
    w.openPanel('downloads');
    await sleep(300);
    ok('İndirilenler paneli dosyaları gösteriyor', (await ux('document.querySelectorAll(".dl").length')) >= 2);
    await capture('06d-downloads');
    w.closePanel();
    w.openPalette('new');
    await sleep(200);
    await ux('const i = document.querySelector(".palette input"); i.value = "sec"; i.dispatchEvent(new InputEvent("input", { inputType: "insertText" })); true');
    await sleep(400);
    const rows = await ux('document.querySelectorAll(".palette .res").length');
    ok('Komut çubuğu yazınca sonuç listeliyor', rows >= 2, `${rows} sonuç`);
    await ux('document.querySelector(".palette input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
    ok('Esc komut çubuğunu kapatıyor', await waitFor(() => !w.modal, 2000));
    // Raising the UI over the page must not flash the UI's own background where
    // the page is (regression: black flicker when opening site settings).
    let raiseShot = null;
    {
      const c = w.buildState().layout.content;
      const rect = { x: Math.round(c.x + c.width / 2 - 20), y: Math.round(c.y + c.height / 2 - 20), width: 40, height: 40 };
      const cv = w.win.contentView;
      const add = cv.addChildView;
      cv.addChildView = function (v, ...rest) {
        const res = add.call(this, v, ...rest);
        if (v === w.uiView && w.modal && !raiseShot) raiseShot = w.uiView.webContents.capturePage(rect);
        return res;
      };
      setTimeout(() => (cv.addChildView = add), 1500);
    }
    await ctl.siteInfo(w);
    await sleep(300);
    {
      let alpha = null;
      if (raiseShot) {
        const b = (await raiseShot).toBitmap();
        let s = 0;
        for (let i = 3; i < b.length; i += 4) s += b[i];
        alpha = Math.round(s / (b.length / 4));
      }
      ok('Pencere açılırken sayfa bir an kararmıyor (titreme yok)', alpha !== null && alpha < 200, `arayüz üste alındığında sayfa bölgesi opaklığı: ${alpha}/255`);
    }
    ok('Site bilgisi penceresi açıldı', (await ux('!!document.querySelector(".siteinfo")')) && w.modal?.type === 'siteinfo');
    await capture('09-siteinfo');
    w.closeModal();
    w.openModal({ type: 'space', data: { id: null, name: '', icon: '', hue: 150 } });
    await sleep(300);
    ok('Alan düzenleyici açıldı', await ux('!!document.querySelector(".hue")'));
    await capture('10-space');
    const spacesBefore = ctl.library.spaces.length;
    await ux('(() => { const i = document.querySelector(".dialog input"); i.value = "Oyun"; i.dispatchEvent(new Event("input")); document.querySelector(".emojis button:nth-child(4)").click(); [...document.querySelectorAll(".dialog .btn.primary")].pop().click(); return true; })()');
    const made = await waitFor(() => ctl.library.spaces.length === spacesBefore + 1 && !w.modal, 3000);
    const newest = ctl.library.spaces[ctl.library.spaces.length - 1];
    ok('Arayüzden yeni alan oluşturuldu ve geçildi', made && newest.name === 'Oyun' && w.activeSpaceId === newest.id, newest.name + ' ' + newest.icon);
    w.switchSpace(ctl.library.spaces[0].id);
    ctl.setSetting('language', 'en');
    await sleep(300);
    const en = await ux('document.querySelector("#btn-newtab .t").textContent');
    ok('Arayüz İngilizceye geçiyor', en === 'New tab', en);
    ctl.setSetting('language', 'tr');
    await sleep(200);
    ok('Arayüzde JavaScript/CSP hatası yok', uiErrors.length === 0, uiErrors.slice(0, 3).join(' | '));

    // --- memory
    await sleep(300);
    const mem = ctl.memoryStats(w);
    const pm = require('electron').app.getAppMetrics().map((x) => `${x.type}:${Math.round((x.memory.privateBytes || x.memory.workingSetSize) / 1024)}`).join(' ');
    const mu = process.memoryUsage();
    console.log(`       ana süreç JS: heap ${Math.round(mu.heapUsed / 1048576)} MB, external ${Math.round(mu.external / 1048576)} MB, arrayBuffers ${Math.round(mu.arrayBuffers / 1048576)} MB`);
    ok('Bellek ölçümü', mem.total > 0, `toplam ${mem.total} MB, ${mem.processes} işlem, ${mem.tabs.length} sekme — ${pm}`);

    // --- light/dark + compact screenshots
    tab.load(base + '/long');
    await loaded(tab);
    ctl.setSetting('sidebarCompact', true);
    await sleep(500);
    ok('Simge şeridi modunda kenar çubuğu 52 px', w.metrics().sidebar === 52);
    ok('Simge şeridinde üstte boşluk yok (alan başlığı gizli)', await w.uiView.webContents.executeJavaScript("getComputedStyle(document.getElementById('spacehead')).display === 'none'"));
    await capture('07-compact');
    ctl.setSetting('sidebarCompact', false);
    ctl.setSetting('theme', 'light');
    await sleep(700);
    await capture('08-light');
    // Drag & drop in the sidebar with real DOM drag events.
    const dnd = (fromSel, toId) =>
      ux(`(() => {
        const dt = new DataTransfer();
        const src = document.querySelector('${fromSel}');
        if (!src) return 'no source';
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const to = document.getElementById('${toId}');
        const r = to.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 6, clientY: r.top + 6 };
        to.dispatchEvent(new DragEvent('dragover', o));
        to.dispatchEvent(new DragEvent('drop', o));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return 'ok';
      })()`);
    await dnd(`#today .row[data-tab="${tab.id}"]`, 'favorites');
    await waitFor(() => ctl.library.favorites.length === 1, 3000);
    await sleep(200);
    await dnd(`#today .row[data-tab="${other.id}"]`, 'pinned');
    await waitFor(() => ctl.library.spaces[0].pinned.length === 1, 3000);
    await sleep(400);
    ok('Sürükle-bırak: sekme sık kullanılanlara ve sabitlenenlere taşındı', ctl.library.favorites.length === 1 && ctl.library.spaces[0].pinned.length === 1, `fav ${ctl.library.favorites.length}, sabit ${ctl.library.spaces[0].pinned.length}`);
    await capture('11-favorites');
    ctl.setSetting('theme', 'dark');
    await sleep(700);
    await capture('08-dark');
  } catch (err) {
    ok('Beklenmeyen hata', false, err.stack);
  }

  server.close();
  const passed = results.filter((r) => r.pass).length;
  const summary = { passed, failed: results.length - passed, total: results.length, seconds: Math.round((Date.now() - t0) / 1000), results };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${results.length} test geçti (${summary.seconds} sn). Rapor: ${path.join(OUT_DIR, 'report.json')}`);
  setTimeout(() => app.exit(summary.failed ? 1 : 0), 300);
}

module.exports = { run };
