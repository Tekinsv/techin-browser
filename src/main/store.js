'use strict';
// Small JSON file store: atomic writes (temp file + rename), debounced saves,
// and a corrupt file is kept aside instead of silently lost.
// While the browser runs, writes are asynchronous so the main (UI) thread —
// which also routes input to pages — never blocks on the disk. saveNow() is
// synchronous and used only when quitting.
const fs = require('node:fs');
const path = require('node:path');

let tmpSeq = 0;

class JsonStore {
  constructor(file, { defaults = () => ({}), sanitize = (v) => v, debounceMs = 600 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.sanitize = sanitize;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.writing = false;
    this.again = false;
    this.gen = 0; // bumped by every synchronous save
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
      this.writeAsync();
    }, this.debounceMs);
  }

  async writeAsync() {
    if (this.writing) {
      this.again = true;
      return;
    }
    this.writing = true;
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`;
    const gen = this.gen;
    try {
      const json = JSON.stringify(this.data);
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, json);
      // A synchronous save (quit) happened meanwhile: its data is newer.
      if (gen !== this.gen) await fs.promises.rm(tmp, { force: true });
      else await fs.promises.rename(tmp, this.file);
    } catch (err) {
      fs.promises.rm(tmp, { force: true }).catch(() => {});
      console.error('[store] could not save', this.file, err.message);
    } finally {
      this.writing = false;
      if (this.again) {
        this.again = false;
        this.save();
      }
    }
  }

  saveNow() {
    this.gen++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      console.error('[store] could not save', this.file, err.message);
    }
  }
}

module.exports = { JsonStore };
