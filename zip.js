/* Minimal ZIP reader for .osz files (stored + deflate via DecompressionStream). */
(function (root) {
  'use strict';

  async function readZip(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Keine gültige ZIP-/OSZ-Datei');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const offset = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      void flags;
      if (!name.endsWith('/')) entries.set(name, { method, csize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      const e = entries.get(name);
      if (!e) throw new Error('Datei fehlt im Archiv: ' + name);
      const nl = dv.getUint16(e.offset + 26, true), el = dv.getUint16(e.offset + 28, true);
      const start = e.offset + 30 + nl + el;
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return data.slice().buffer;
      if (e.method !== 8) throw new Error('Nicht unterstützte ZIP-Kompression: ' + e.method);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer();
    }
    return { names: [...entries.keys()], read };
  }

  root.MiniZip = { readZip };
})(typeof window !== 'undefined' ? window : globalThis);
