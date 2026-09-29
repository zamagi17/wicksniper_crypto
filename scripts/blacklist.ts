#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';

const p = path.resolve(__dirname, '../data_cache/blacklist.json');

function load() {
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function save(list: any[]) { fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8'); }

const cmd = process.argv[2] || 'list';

if (cmd === 'list') {
  const list = load();
  if (!list.length) {
    console.log('Blacklist kosong');
    process.exit(0);
  }
  for (const it of list) {
    console.log(`${it.symbol} • reason=${it.reason} • expires=${it.expiresAt ? new Date(it.expiresAt).toLocaleString() : 'never'}`);
  }
} else if (cmd === 'clear') {
  save([]);
  console.log('Blacklist dibersihkan.');
} else if (cmd === 'remove') {
  const sym = (process.argv[3] || '').toUpperCase();
  if (!sym) { console.error('Gunakan: remove SYMBOL'); process.exit(2); }
  const list = load();
  const idx = list.findIndex((l: any) => l.symbol === sym);
  if (idx === -1) { console.log('Symbol tidak ditemukan'); process.exit(0); }
  list.splice(idx, 1);
  save(list);
  console.log(`Removed ${sym}`);
} else {
  console.log('Unknown command. Use: list | clear | remove SYMBOL');
}
