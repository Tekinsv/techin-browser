'use strict';
// Small JSON file store: atomic writes (temp file + rename), debounced saves,
// and a corrupt file is kept aside instead of silently lost.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(file, { defaults = () => ({}), sanitize = (v) => v, debounceMs = 600 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.sanitize = sanitize;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.data = this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this.sanitize(this.defaults());
    }
    try {
      return this.sanitize(JSON.parse(raw));
    } catch {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {}
      return this.sanitize(this.defaults());
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, this.debounceMs);
  }

  saveNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] could not save', this.file, err.message);
    }
  }
}

module.exports = { JsonStore };
