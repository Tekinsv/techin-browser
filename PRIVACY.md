# Privacy Policy

Techin Browser has no accounts, no telemetry and no analytics. The developers
receive nothing about you or your browsing.

## What stays on your computer

History, bookmarks, favorites, open tabs, settings, site permissions, cookies
and saved passwords are stored only in your Windows profile
(`%APPDATA%\Techin Browser`). Passwords and cookies are encrypted with the
Windows data protection API (DPAPI). Nothing of this is synced or uploaded.

Importing from another browser (Settings → Import) reads that browser's
bookmark and history files on this computer only, and only when you start it.

## Connections the browser makes on its own

Besides the sites you open, the browser contacts these services. None of them
receive your history, passwords or personal data from Techin Browser.

| Service | Why | Can it be turned off |
|---|---|---|
| GitHub (`github.com`) | Checks for and downloads updates | No |
| Ghostery adblocker filter lists | Ad and tracker blocking lists | Turn off the ad blocker |
| malware-filter (`malware-filter.gitlab.io`) | Malware and phishing site lists | Turn off malware protection |
| Google Widevine (via castlabs component updater) | DRM module needed for protected video (Netflix etc.) | No |
| Google spell-check dictionaries | Downloads the dictionary for your language | Turn off spell check |
| Your search engine | Search suggestions while you type in the address bar | Turn off search suggestions |
| Chrome Web Store (`chromewebstore.google.com`, `clients2.google.com`, `update.googleapis.com`) | Installs the extensions you add; checks them for updates at start and every 5 hours | Remove your extensions |

Extensions you install run with the permissions shown when you add them and
follow their own privacy policies.

Each of these services has its own privacy policy. Websites you visit can of
course see your IP address and anything you send them, as in any browser.

## Third-party components

Techin Browser is built on castlabs Electron (Chromium) and uses the Ghostery
adblocker engine. Protected video uses Google's Widevine module, which is
downloaded at runtime and governed by Google's terms.

## Contact

Questions: open an issue at https://github.com/Tekinsv/techin-browser/issues
