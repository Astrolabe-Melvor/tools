// Brotli decoder (RFC 7932) for the browser, so the wiki can read a save without uploading it.
// Written for Astrolabe; the static dictionary (brotli-dict.bin), context table and transforms are the
// standard ones from the reference implementation (MIT, github.com/google/brotli).
// Usage: Brotli.decode(bytes, dict) -> Uint8Array. Streams that were flushed but never closed (like
// Melvor Idle 2 saves) decode up to their last complete meta-block.
(function () {
'use strict';
const LUT_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+PwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8AAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEBAQICAgIDAwMDBAQEBAUFBQUGBgYGBwcHBwgICAgJCQkJCgoKCgsLCwsMDAwMDQ0NDQ4ODg4PDw8PEBAQEBERERESEhISExMTExQUFBQVFRUVFhYWFhcXFxcYGBgYGRkZGRoaGhobGxsbHBwcHB0dHR0eHh4eHx8fHyAgICAhISEhIiIiIiMjIyMkJCQkJSUlJSYmJiYnJycnKCgoKCkpKSkqKioqKysrKywsLCwtLS0tLi4uLi8vLy8wMDAwMTExMTIyMjIzMzMzNDQ0NDU1NTU2NjY2Nzc3Nzg4ODg5OTk5Ojo6Ojs7Ozs8PDw8PT09PT4+Pj4/Pz8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAEAAAAAAAAAAAAAAAAAAAAAAAACAwQDAwUDBAYHAwMIAwkDCwsLCwsLCwsLCwgIBgoHAwMMDQ0NDA0NDQwNDQ0NDQwNDQ0NDQwNDQ0NDQYDBwMDAw4PDw8ODw8PDg8PDw8PDg8PDw8PDg8PDw8PBgMHAwAAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQEBAQEBAQEBAQEBAQECAgICAgICAgICAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAQEBAQEBAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMBAQEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAgICAgICAgICAgICAgICBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBggICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoMDAwMDAwMDAwMDAwMDAwOAABAQEBAQEBAQEBAQEBAQECAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQYGBgYGBgYGBgYGBgYGBgc=';
const TRANSFORMS = [["",0,""],["",0," "],[" ",0," "],["",12,""],["",10," "],["",0," the "],[" ",0,""],["s ",0," "],["",0," of "],["",10,""],["",0," and "],["",13,""],["",1,""],[", ",0," "],["",0,", "],[" ",10," "],["",0," in "],["",0," to "],["e ",0," "],["",0,"\""],["",0,"."],["",0,"\">"],["",0,"\n"],["",3,""],["",0,"]"],["",0," for "],["",14,""],["",2,""],["",0," a "],["",0," that "],[" ",10,""],["",0,". "],[".",0,""],[" ",0,", "],["",15,""],["",0," with "],["",0,"'"],["",0," from "],["",0," by "],["",16,""],["",17,""],[" the ",0,""],["",4,""],["",0,". The "],["",11,""],["",0," on "],["",0," as "],["",0," is "],["",7,""],["",1,"ing "],["",0,"\n\t"],["",0,":"],[" ",0,". "],["",0,"ed "],["",20,""],["",18,""],["",6,""],["",0,"("],["",10,", "],["",8,""],["",0," at "],["",0,"ly "],[" the ",0," of "],["",5,""],["",9,""],[" ",10,", "],["",10,"\""],[".",0,"("],["",11," "],["",10,"\">"],["",0,"=\""],[" ",0,"."],[".com/",0,""],[" the ",0," of the "],["",10,"'"],["",0,". This "],["",0,","],[".",0," "],["",10,"("],["",10,"."],["",0," not "],[" ",0,"=\""],["",0,"er "],[" ",11," "],["",0,"al "],[" ",11,""],["",0,"='"],["",11,"\""],["",10,". "],[" ",0,"("],["",0,"ful "],[" ",10,". "],["",0,"ive "],["",0,"less "],["",11,"'"],["",0,"est "],[" ",10,"."],["",11,"\">"],[" ",0,"='"],["",10,","],["",0,"ize "],["",11,"."],["\u00c2\u00a0",0,""],[" ",0,","],["",10,"=\""],["",11,"=\""],["",0,"ous "],["",11,", "],["",10,"='"],[" ",10,","],[" ",11,"=\""],[" ",11,", "],["",11,","],["",11,"("],["",11,". "],[" ",11,"."],["",11,"='"],[" ",11,". "],[" ",10,"=\""],[" ",11,"='"],[" ",10,"='"]];
const fromB64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const atob = typeof globalThis.atob === 'function' ? globalThis.atob : s => Buffer.from(s, 'base64').toString('latin1');
let LUT = null;

const BLEN_BASE = [1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625];
const BLEN_BITS = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24];
const INS_BASE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594];
const INS_BITS = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24];
const CPY_BASE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118];
const CPY_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24];
// Insert-and-copy cells (symbol >> 6): [insert code base, copy code base, uses the last distance].
const CELLS = [[0, 0, 1], [0, 8, 1], [0, 0, 0], [0, 8, 0], [8, 0, 0], [8, 8, 0], [0, 16, 0], [16, 0, 0], [8, 16, 0], [16, 8, 0], [16, 16, 0]];
const CL_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CL_LEN = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4];
const CL_VAL = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5];
const DICT_BITS = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5];
const DICT_OFF = [];
{ let o = 0; for (let l = 0; l < 25; l++) { DICT_OFF.push(o); if (l >= 4) o += l << DICT_BITS[l]; } }

class Bits {
  constructor(u8) { this.b = u8; this.p = 0; this.v = 0; this.n = 0; this.over = 0; }
  fill() { while (this.n <= 24) { let x = 0; if (this.p < this.b.length) x = this.b[this.p]; else this.over++; this.p++; this.v = (this.v | (x << this.n)) >>> 0; this.n += 8; } }
  peek(k) { if (this.n < k) this.fill(); return this.v & ((1 << k) - 1); }
  drop(k) { this.v >>>= k; this.n -= k; }
  read(k) { if (k === 0) return 0; if (this.n < k) this.fill(); const x = k === 32 ? this.v : this.v & ((1 << k) - 1); this.v >>>= k; this.n -= k; return x; }
  align() { this.drop(this.n & 7); }
  used() { return this.p * 8 - this.n; } // bits consumed
  check() { if (this.used() > this.b.length * 8) throw new Error('truncated'); }
}

// A prefix code: lengths -> canonical code. Fast 8-bit table plus a slow path for longer codes.
function Tree(lens) {
  const n = lens.length, count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
  let nz = 0, last = 0;
  for (let i = 0; i < n; i++) if (lens[i]) { count[lens[i]]++; nz++; last = i; }
  this.single = nz === 1 ? last : nz === 0 ? 0 : -1;
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  for (let i = 0; i < n; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
  this.count = count; this.sym = sym;
  const tab = new Uint32Array(256);
  let code = 0, k = 0;
  for (let l = 1; l <= 8; l++) {
    for (let j = 0; j < count[l]; j++, k++, code++) {
      let r = 0; for (let b = 0; b < l; b++) r |= ((code >> b) & 1) << (l - 1 - b);
      for (let f = r; f < 256; f += 1 << l) tab[f] = (l << 16) | sym[k];
    }
    code <<= 1;
  }
  this.tab = tab;
}
function sym(br, t) {
  if (t.single >= 0) return t.single;
  const e = t.tab[br.peek(8)];
  if (e) { br.drop(e >>> 16); return e & 0xffff; }
  let code = 0, first = 0, index = 0;
  for (let l = 1; l <= 15; l++) {
    code |= br.read(1);
    const c = t.count[l];
    if (code - first < c) return t.sym[index + code - first];
    index += c; first += c; first <<= 1; code <<= 1;
  }
  throw new Error('bad prefix code');
}

function readTree(br, size) {
  const lens = new Uint8Array(size);
  const hskip = br.read(2);
  if (hskip === 1) {
    let bits = 0; for (let i = size - 1; i; i >>= 1) bits++;
    const ns = br.read(2) + 1, s = [];
    for (let i = 0; i < ns; i++) { const x = br.read(bits); if (x >= size) throw new Error('bad simple code'); s.push(x); }
    if (ns === 1) lens[s[0]] = 1;
    else if (ns === 2) { lens[s[0]] = 1; lens[s[1]] = 1; }
    else if (ns === 3) { lens[s[0]] = 1; lens[s[1]] = 2; lens[s[2]] = 2; }
    else if (br.read(1)) { lens[s[0]] = 1; lens[s[1]] = 2; lens[s[2]] = 3; lens[s[3]] = 3; }
    else for (const x of s) lens[x] = 2;
    const t = new Tree(lens);
    if (ns === 1) t.single = s[0];
    return t;
  }
  const cl = new Uint8Array(18);
  let space = 32, num = 0;
  for (let i = hskip; i < 18; i++) {
    const p = br.peek(4), l = CL_LEN[p]; br.drop(l);
    const v = CL_VAL[p];
    cl[CL_ORDER[i]] = v;
    if (v) { space -= 32 >> v; num++; if (space <= 0) break; }
  }
  if (!(num === 1 || space === 0)) throw new Error('bad code length code');
  const ct = new Tree(cl);
  let s = 0, prev = 8, rep = 0, repLen = 0; space = 32768;
  while (s < size && space > 0) {
    const c = sym(br, ct);
    if (c < 16) {
      rep = 0; lens[s++] = c;
      if (c) { prev = c; space -= 32768 >> c; }
    } else {
      const extra = c === 16 ? 2 : 3, nl = c === 16 ? prev : 0;
      if (repLen !== nl) { rep = 0; repLen = nl; }
      const old = rep;
      if (rep > 0) rep = (rep - 2) << extra;
      rep += br.read(extra) + 3;
      const d = rep - old;
      if (s + d > size) throw new Error('bad repeat');
      for (let j = 0; j < d; j++) lens[s++] = repLen;
      if (repLen) space -= d * (32768 >> repLen);
    }
  }
  return new Tree(lens);
}

function varLen8(br) { if (!br.read(1)) return 0; const n = br.read(3); return n === 0 ? 1 : (1 << n) + br.read(n); }
function blockLen(br, t) { const c = sym(br, t); return BLEN_BASE[c] + br.read(BLEN_BITS[c]); }

function contextMap(br, size, ntrees) {
  const m = new Uint8Array(size);
  if (ntrees < 2) return m;
  const rleMax = br.read(1) ? br.read(4) + 1 : 0;
  const t = readTree(br, ntrees + rleMax);
  for (let i = 0; i < size;) {
    const c = sym(br, t);
    if (c === 0) m[i++] = 0;
    else if (c <= rleMax) { let r = (1 << c) + br.read(c); if (i + r > size) throw new Error('bad context map'); while (r--) m[i++] = 0; }
    else m[i++] = c - rleMax;
  }
  if (br.read(1)) { // inverse move-to-front
    const mtf = new Uint8Array(256); for (let i = 0; i < 256; i++) mtf[i] = i;
    for (let i = 0; i < size; i++) {
      const x = m[i], v = mtf[x]; m[i] = v;
      if (x) { for (let j = x; j > 0; j--) mtf[j] = mtf[j - 1]; mtf[0] = v; }
    }
  }
  return m;
}

function upper(w, i) {
  if (w[i] < 0xc0) { if (w[i] >= 97 && w[i] <= 122) w[i] ^= 32; return 1; }
  if (w[i] < 0xe0) { if (i + 1 < w.length) w[i + 1] ^= 32; return 2; }
  if (i + 2 < w.length) w[i + 2] ^= 5; return 3;
}
function latin(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
let TR = null;

function decode(input, dict) {
  if (!(input instanceof Uint8Array)) input = new Uint8Array(input);
  if (!LUT) { LUT = fromB64(LUT_B64); TR = TRANSFORMS.map(([p, t, s]) => [latin(p), t, latin(s)]); }
  const br = new Bits(input);
  let out = new Uint8Array(Math.max(1 << 16, input.length * 4)), pos = 0;
  const grow = need => { if (need <= out.length) return; let n = out.length * 2; while (n < need) n *= 2; const o = new Uint8Array(n); o.set(out.subarray(0, pos)); out = o; };
  let wbits = 16;
  if (br.read(1)) { const n = br.read(3); if (n) wbits = 17 + n; else { const m = br.read(3); if (m === 1) throw new Error('large-window brotli is not supported'); wbits = m ? 8 + m : 17; } }
  const maxBack = (1 << wbits) - 16;
  const dist = [16, 15, 11, 4]; let di = 0; // ring of the last four distances; dist[(di - 1) & 3] is the last
  let complete = false;
  try {
    for (;;) {
      if (br.used() >= input.length * 8) break; // flushed but not closed: stop at the end of the data
      const last = br.read(1);
      if (last && br.read(1)) { complete = true; break; }
      const nib = br.read(2);
      if (nib === 3) { // metadata
        if (br.read(1)) throw new Error('reserved bit set');
        const nb = br.read(2); let len = 0;
        for (let i = 0; i < nb; i++) len |= br.read(8) << (8 * i);
        if (nb) len++;
        br.align();
        for (let i = 0; i < len; i++) br.read(8);
        br.check();
        if (last) { complete = true; break; }
        continue;
      }
      let mlen = 0;
      for (let i = 0; i < nib + 4; i++) mlen |= br.read(4) << (4 * i);
      mlen++;
      if (!last && br.read(1)) { // uncompressed
        br.align(); grow(pos + mlen);
        for (let i = 0; i < mlen; i++) out[pos++] = br.read(8);
        br.check();
        continue;
      }
      grow(pos + mlen);
      // Block types and counts for literals (0), commands (1) and distances (2).
      const nbt = [], ttree = [], ltree = [], blen = [], btype = [0, 0, 0], rb = [[1, 0], [1, 0], [1, 0]];
      for (let k = 0; k < 3; k++) {
        nbt[k] = varLen8(br) + 1;
        if (nbt[k] >= 2) { ttree[k] = readTree(br, nbt[k] + 2); ltree[k] = readTree(br, 26); blen[k] = blockLen(br, ltree[k]); }
        else blen[k] = 1 << 28;
      }
      const npost = br.read(2), ndirect = br.read(4) << npost, pmask = (1 << npost) - 1;
      const cmode = new Uint8Array(nbt[0]);
      for (let i = 0; i < nbt[0]; i++) cmode[i] = br.read(2);
      const ntl = varLen8(br) + 1, cmapL = contextMap(br, nbt[0] << 6, ntl);
      const ntd = varLen8(br) + 1, cmapD = contextMap(br, nbt[2] << 2, ntd);
      const lit = [], cmd = [], dst = [];
      for (let i = 0; i < ntl; i++) lit.push(readTree(br, 256));
      for (let i = 0; i < nbt[1]; i++) cmd.push(readTree(br, 704));
      const dsize = 16 + ndirect + (48 << npost);
      for (let i = 0; i < ntd; i++) dst.push(readTree(br, dsize));
      br.check();
      const sw = k => {
        let t = sym(br, ttree[k]);
        if (t === 1) t = rb[k][1] + 1; else if (t === 0) t = rb[k][0]; else t -= 2;
        if (t >= nbt[k]) t -= nbt[k];
        rb[k][0] = rb[k][1]; rb[k][1] = t; btype[k] = t;
        blen[k] = blockLen(br, ltree[k]);
      };
      let lutOff = cmode[0] << 9, cmOff = 0, cmdTree = cmd[0], dOff = 0;
      let rem = mlen;
      while (rem > 0) {
        if (blen[1] === 0) { sw(1); cmdTree = cmd[btype[1]]; }
        blen[1]--;
        const c = sym(br, cmdTree), cell = CELLS[c >> 6];
        const ic = cell[0] + ((c >> 3) & 7), cc = cell[1] + (c & 7);
        const ins = INS_BASE[ic] + br.read(INS_BITS[ic]);
        const cpy = CPY_BASE[cc] + br.read(CPY_BITS[cc]);
        for (let i = 0; i < ins; i++) {
          if (blen[0] === 0) { sw(0); lutOff = cmode[btype[0]] << 9; cmOff = btype[0] << 6; }
          blen[0]--;
          const p1 = pos ? out[pos - 1] : 0, p2 = pos > 1 ? out[pos - 2] : 0;
          out[pos++] = sym(br, lit[cmapL[cmOff + (LUT[lutOff + p1] | LUT[lutOff + 256 + p2])]]);
        }
        rem -= ins;
        br.check();
        if (rem <= 0) break;
        let d;
        if (cell[2]) d = dist[(di - 1) & 3];
        else {
          if (blen[2] === 0) { sw(2); dOff = btype[2] << 2; }
          blen[2]--;
          const dc = sym(br, dst[cmapD[dOff + (cpy > 4 ? 3 : cpy - 2)]]);
          let push = true;
          if (dc < 16) {
            if (dc === 0) { d = dist[(di - 1) & 3]; push = false; }
            else if (dc < 4) d = dist[(di - 1 - dc) & 3];
            else {
              const base = dist[(di - (dc < 10 ? 1 : 2)) & 3], k = (dc - 4) % 6;
              d = base + [-1, 1, -2, 2, -3, 3][k];
            }
          } else if (dc < 16 + ndirect) d = dc - 15;
          else {
            const x = dc - ndirect - 16, nb = 1 + (x >> (npost + 1)), h = x >> npost;
            const off = ((2 + (h & 1)) << nb) - 4;
            d = ((off + br.read(nb)) << npost) + (x & pmask) + ndirect + 1;
          }
          if (d <= 0) throw new Error('bad distance');
          const maxD = Math.min(maxBack, pos);
          if (push && d <= maxD) { dist[di & 3] = d; di++; }
        }
        const maxD = Math.min(maxBack, pos);
        if (d > maxD) { // static dictionary word
          if (!dict) throw new Error('needs the brotli dictionary');
          if (cpy < 4 || cpy > 24) throw new Error('bad dictionary reference');
          const id = d - maxD - 1, nb = DICT_BITS[cpy], wi = id & ((1 << nb) - 1), ti = id >> nb;
          if (ti >= TR.length) throw new Error('bad transform');
          const [pre, type, suf] = TR[ti];
          let w = dict.slice(DICT_OFF[cpy] + wi * cpy, DICT_OFF[cpy] + wi * cpy + cpy);
          if (type >= 1 && type <= 9) w = w.subarray(0, Math.max(0, w.length - type));
          else if (type >= 12 && type <= 20) w = w.subarray(Math.min(w.length, type - 11));
          if (type === 10 && w.length) upper(w, 0);
          else if (type === 11) for (let i = 0; i < w.length;) i += upper(w, i);
          const len = pre.length + w.length + suf.length;
          grow(pos + len);
          out.set(pre, pos); pos += pre.length; out.set(w, pos); pos += w.length; out.set(suf, pos); pos += suf.length;
          rem -= len;
        } else {
          grow(pos + cpy);
          for (let i = 0; i < cpy; i++, pos++) out[pos] = out[pos - d];
          rem -= cpy;
        }
        br.check();
      }
      if (rem < 0) throw new Error('meta-block overrun');
      if (last) { complete = true; break; }
    }
  } catch (e) {
    if (e.message !== 'truncated') throw e;
  }
  const r = out.slice(0, pos);
  r.complete = complete;
  return r;
}
const api = { decode };
if (typeof module !== 'undefined') module.exports = api; else window.Brotli = api;
})();
