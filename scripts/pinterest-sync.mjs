#!/usr/bin/env node
// Copies new drawings from a Pinterest board into sketchbook/.
// Reads the board's public RSS feed, downloads each new pin's image into
// sketchbook/img/ and lists it in sketchbook/sketchbook.json, which the site
// reads. Drawings already downloaded are kept even after they drop out of the
// feed. No dependencies; needs Node 18 or newer.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.SKETCHBOOK_ROOT || '.');
const DIR = path.join(ROOT, 'sketchbook');
const IMG_DIR = path.join(DIR, 'img');
const CONFIG_FILE = path.join(DIR, 'config.json');
const DATA_FILE = path.join(DIR, 'sketchbook.json');
const KEEP_ALIVE_DAYS = 25; // GitHub pauses hourly jobs after 60 quiet days
const MAX_BYTES = 15 * 1024 * 1024;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const log = (...a) => console.log(...a);
const warn = msg => console.log(`::warning::${msg}`);

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// Board link -> RSS link. Accepts a board link, a profile link or a .rss link.
export function feedUrl(board) {
  if (process.env.SKETCHBOOK_FEED) return process.env.SKETCHBOOK_FEED;
  if (!board) return '';
  let u;
  try { u = new URL(board.trim()); } catch { return ''; }
  if (u.pathname.endsWith('.rss')) return u.href;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'pin') return '';
  if (parts.length === 1) return `${u.origin}/${parts[0]}/feed.rss`;
  if (parts.length >= 2) return `${u.origin}/${parts[0]}/${parts[1]}.rss`;
  return '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const field = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const clean = s => s.replace(/\s+/g, ' ').trim();

export function parseFeed(xml) {
  const pins = [];
  for (const [, it] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const link = clean(decode(field(it, 'link')));
    const guid = clean(decode(field(it, 'guid')));
    const html = decode(field(it, 'description'));
    let image = (html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!image) image = (it.match(/<(?:enclosure|media:content)\b[^>]*\burl\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    image = decode(image);
    const text = clean(decode(html.replace(/<[^>]+>/g, ' ')));
    const title = clean(decode(decode(field(it, 'title'))));
    const when = new Date(clean(decode(field(it, 'pubDate'))));
    const id = (`${link} ${guid}`.match(/\/pin\/(\d+)/) || [])[1] || (image.match(/\/([0-9a-f]{16,})\.[a-z]+(?:\?|$)/i) || [])[1] || '';
    if (!id || !/^https?:\/\//i.test(image)) continue;
    pins.push({ id, link: link || guid, title, text, image, date: isNaN(when) ? null : when.toISOString() });
  }
  return pins;
}

// The feed links small thumbnails (236x). Try the full-size copies first.
export function candidates(src) {
  const m = src.match(/^(https?:\/\/[^/]+)\/(?:\d+x\d*|originals)\/(.+)$/i);
  if (!m) return [src];
  const [, host, rest] = m;
  const base = rest.replace(/\.[a-z0-9]+$/i, '');
  // Originals keep the uploaded format, which is often PNG even when the thumbnail is JPEG.
  const originals = [rest, `${base}.png`, `${base}.jpg`, `${base}.gif`].map(r => `${host}/originals/${r}`);
  return [...new Set([...originals, `${host}/1200x/${rest}`, `${host}/736x/${rest}`, src])];
}

async function download(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/jpeg,image/png,image/*;q=0.8' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!EXT[type]) throw new Error(`not a usable image (${type || 'no type'})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw new Error(`bad size (${buf.length} bytes)`);
  return { buf, type };
}

// Width and height from the file header, so the page can reserve space.
export function dimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
  }
  return {};
}

// Share links from the Pinterest app (pin.it/...) redirect to the board.
export async function resolveBoard(board) {
  let u;
  try { u = new URL(String(board || '').trim()); } catch { return String(board || '').trim(); }
  if (!/(^|\.)pin\.it$/i.test(u.hostname)) return `${u.origin}${u.pathname}`;
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const final = new URL(r.url);
    return `${final.origin}${final.pathname}`;
  } catch (e) {
    warn(`Could not open the short link ${u.href} (${e.message}).`);
    return u.href;
  }
}

// Dry run: check that a board link works, without saving anything.
async function tryBoard(link) {
  const board = await resolveBoard(link);
  if (board !== link) log(`${link} leads to ${board}`);
  const feed = feedUrl(board);
  if (!feed) { warn(`"${board}" is not a board link. Share the board itself, not a single pin.`); return; }
  log(`Checking ${feed}`);
  let r;
  try { r = await fetch(feed, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' } }); }
  catch (e) { warn(`Could not reach the feed (${e.message}).`); return; }
  log(`HTTP ${r.status}, ${r.headers.get('content-type') || 'no content type'}`);
  const xml = r.ok ? await r.text() : '';
  const pins = parseFeed(xml);
  log(`The feed lists ${pins.length} pin(s).`);
  pins.slice(0, 3).forEach(p => log(`  ${p.id}  ${p.date || 'no date'}  ${(p.title || p.text || '(no title)').slice(0, 60)}`));
  if (!pins.length) { warn('No pins found. Is the board public and the link right?'); return; }
  for (const url of candidates(pins[0].image)) {
    try { const got = await download(url); const d = dimensions(got.buf); console.log(`::notice::Board link works: ${board} has ${pins.length} pin(s) in its feed, newest image ${d.width || '?'}x${d.height || '?'} (${Math.round(got.buf.length / 1024)} KB) from ${new URL(url).pathname.split('/')[1]}.`); return; }
    catch (e) { log(`  ${url} -> ${e.message}`); }
  }
  warn('The feed works, but its images could not be downloaded.');
}

async function main() {
  if (process.env.SKETCHBOOK_TEST_BOARD) return tryBoard(process.env.SKETCHBOOK_TEST_BOARD.trim());
  const config = await readJSON(CONFIG_FILE, {});
  const data = await readJSON(DATA_FILE, {});
  data.items = Array.isArray(data.items) ? data.items : [];
  const hide = new Set((Array.isArray(config.hide) ? config.hide : []).map(String));
  const board = config.board ? await resolveBoard(config.board) : '';
  const feed = feedUrl(board);
  if (board && !feed) warn(`"${board}" is not a board link. Share the board itself, not a single pin.`);
  let changed = false;

  for (const it of data.items.filter(it => hide.has(String(it.id)))) {
    if (it.file) await rm(path.join(IMG_DIR, path.basename(it.file)), { force: true });
    log(`Removed hidden drawing ${it.id}.`);
    changed = true;
  }
  data.items = data.items.filter(it => !hide.has(String(it.id)));
  if ((data.board || null) !== (board || null)) { data.board = board || null; changed = true; }

  if (!feed) {
    log('No Pinterest board in sketchbook/config.json yet. Nothing to sync.');
  } else {
    let xml = '';
    try {
      const r = await fetch(feed, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      xml = await r.text();
    } catch (e) {
      warn(`Could not read the Pinterest feed at ${feed} (${e.message}). Is the board public and the link right?`);
    }
    if (xml) {
      const pins = parseFeed(xml);
      log(`The feed lists ${pins.length} pin(s).`);
      if (!pins.length && !/<rss\b|<feed\b/i.test(xml)) warn(`${feed} did not return an RSS feed.`);
      const known = new Set(data.items.map(it => String(it.id)));
      await mkdir(IMG_DIR, { recursive: true });
      for (const pin of pins) {
        if (known.has(pin.id) || hide.has(pin.id)) continue;
        let got = null, used = '';
        for (const url of candidates(pin.image)) {
          try { got = await download(url); used = url; break; } catch (e) { log(`  ${pin.id}: ${url} -> ${e.message}`); }
        }
        if (!got) { warn(`Skipped pin ${pin.id}: its image could not be downloaded.`); continue; }
        const file = `${pin.id}.${EXT[got.type]}`;
        await writeFile(path.join(IMG_DIR, file), got.buf);
        data.items.push({
          id: pin.id,
          title: (pin.title || pin.text || '').slice(0, 140),
          alt: (pin.text || pin.title || '').slice(0, 300),
          link: pin.link,
          date: pin.date,
          file,
          ...dimensions(got.buf),
          source: used,
        });
        known.add(pin.id);
        changed = true;
        log(`  Added ${pin.id} (${file}, ${Math.round(got.buf.length / 1024)} KB)`);
      }
    }
  }

  data.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const now = new Date();
  if (changed) data.updatedAt = now.toISOString();
  const lastAlive = Date.parse(data.keepAlive || '') || 0;
  if (changed || now - lastAlive > KEEP_ALIVE_DAYS * 864e5) { data.keepAlive = now.toISOString(); changed = true; }
  if (changed) {
    await mkdir(DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify({ board: data.board || null, updatedAt: data.updatedAt || null, keepAlive: data.keepAlive, items: data.items }, null, 2) + '\n');
    log(`Saved sketchbook.json (${data.items.length} drawing(s)).`);
  } else {
    log('No changes.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
