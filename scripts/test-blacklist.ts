import fs from 'fs';
import path from 'path';

const p = path.resolve(process.cwd(), 'data_cache/blacklist.json');
const backup = path.resolve(process.cwd(), 'data_cache/blacklist.backup.json');

function read() {
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function write(list: any[]) { fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8'); }

(async () => {
  console.log('=== TEST BLACKLIST START ===');
  // backup
  if (fs.existsSync(p)) fs.copyFileSync(p, backup);

  try {
    // ensure clean
    write([]);
    console.log('- Cleared existing blacklist');

    // Add entry
    const entry = { symbol: 'TESTUSDT', reason: 'unit-test', vol24: 999999, addedAt: Date.now(), expiresAt: Date.now() + 3600 * 1000 };
    const list = read();
    list.push(entry);
    write(list);
    console.log('- Wrote entry TESTUSDT');

    // Verify
    const after = read();
    const found = after.find((it: any) => it.symbol === 'TESTUSDT');
    if (!found) throw new Error('Entry not found after write');
    console.log('- Verified entry present');

    // Remove entry
    const idx = after.findIndex((it: any) => it.symbol === 'TESTUSDT');
    if (idx !== -1) {
      after.splice(idx, 1);
      write(after);
    }
    console.log('- Removed entry');

    // Final verify
    const final = read();
    if (final.find((it: any) => it.symbol === 'TESTUSDT')) throw new Error('Entry still present after remove');
    console.log('- Verified removal');

    console.log('✅ All blacklist tests passed');
  } catch (err: any) {
    console.error('❌ Test failed:', err.message || err);
    process.exitCode = 2;
  } finally {
    // restore backup
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, p);
      fs.unlinkSync(backup);
      console.log('- Restored backup');
    }
  }
})();
