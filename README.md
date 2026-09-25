# Techin Browser

A fast, private, Chromium-based browser for Windows with an Arc-style sidebar.

- **Arc-style UI:** favorites, spaces, pinned tabs, command bar (Ctrl+T), split view, hideable / icon-strip sidebar
- **Private & secure:** sandboxed tabs, built-in ad & tracker blocker, malware and phishing protection, HTTPS-only mode, per-site permissions
- **Low memory:** tabs you don't use go to sleep and resume where they left off
- **Smooth:** momentum scrolling and GPU rendering for Shorts/Reels-style feeds
- **DRM:** Widevine (castlabs Electron) for protected video
- **Automatic updates** from GitHub Releases
- Turkish and English interface

## Download

Get the latest `Techin-Browser-Setup-x.y.z.exe` from [Releases](https://github.com/Tekinsv/techin-browser/releases/latest).
The installer is not code-signed yet, so Windows SmartScreen may ask you to confirm (**More info → Run anyway**).

## Development

```
npm install
node node_modules/electron/install.js   # castlabs Electron binary
npm start          # run
npm test           # unit tests
npm run selftest   # end-to-end self test in a real window
npm run dist       # build the installer into dist/
```

Details (in Turkish): [KURULUM.md](KURULUM.md)
