'use strict';

const DEFAULT_MAX_BUFFER = 1_000_000;

class JSONFramer {
  constructor({ maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
    this.maxBuffer = maxBuffer;
    this._reset();
  }

  _reset() {
    this.buf = '';
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.objectStart = -1;
  }

  push(chunk) {
    if (chunk == null) return [];
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (this.buf.length > this.maxBuffer) {
      const nl = this.buf.indexOf('\n');
      const dropped = nl >= 0 ? nl + 1 : this.buf.length;
      this.buf = nl >= 0 ? this.buf.slice(nl + 1) : '';
      this.depth = 0;
      this.inString = false;
      this.escape = false;
      this.objectStart = -1;
      return [{ ok: false, error: `buffer overflow, dropped ${dropped} bytes` }];
    }

    // Reset parse state and re-walk the entire buffer. The buffer is sliced
    // after each push to start at the in-flight object's `{` (or be empty),
    // so a fresh walk yields the same end state idempotently — no need to
    // track scan position across pushes.
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.objectStart = -1;

    const emitted = [];
    let i = 0;

    while (i < this.buf.length) {
      const ch = this.buf[i];

      if (this.escape) {
        this.escape = false;
        i++;
        continue;
      }
      if (this.inString) {
        if (ch === '\\') this.escape = true;
        else if (ch === '"') this.inString = false;
        i++;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
        i++;
        continue;
      }
      if (ch === '{') {
        if (this.depth === 0) this.objectStart = i;
        this.depth++;
        i++;
        continue;
      }
      if (ch === '}') {
        this.depth--;
        if (this.depth === 0 && this.objectStart >= 0) {
          emitted.push(this.buf.slice(this.objectStart, i + 1));
          this.objectStart = -1;
        } else if (this.depth < 0) {
          this.depth = 0;
          this.objectStart = -1;
        }
        i++;
        continue;
      }
      i++;
    }

    if (this.depth === 0) {
      this.buf = '';
    } else if (this.objectStart > 0) {
      this.buf = this.buf.slice(this.objectStart);
      this.objectStart = 0;
    }

    return emitted.map((raw) => {
      try {
        return { ok: true, raw, value: JSON.parse(raw) };
      } catch (err) {
        return { ok: false, raw, error: err.message };
      }
    });
  }
}

module.exports = { JSONFramer };
