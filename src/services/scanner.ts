import { BotConfig, SpikeAlert, TickerSnapshot } from '../types';
import { binanceFutures } from './binance';
import { logger } from './logger';
import fs from 'fs';
import path from 'path';
import { telegram } from './telegram';

export interface BlacklistEntry {
  symbol: string;
  reason: string;
  vol24?: number;
  addedAt: number;
  expiresAt?: number;
  auto?: boolean;
}

export class SpikeScanner {
  private config: BotConfig['scanner'];
  private priceHistory: Map<string, TickerSnapshot[]> = new Map();
  private cooldowns: Map<string, number> = new Map(); // symbol -> epochMs
  private alertListeners: ((alert: SpikeAlert) => void)[] = [];
  private recentSpikes: SpikeAlert[] = [];
  private lastPrices: Map<string, number> = new Map();
  private tickCount: number = 0;
  private lastTickReset: number = Date.now();
  private ticksPerSecond: number = 0;
  private lastDataAt: number = 0;
  private blacklistMap: Map<string, BlacklistEntry> = new Map();
  private blacklistSaveTimer: NodeJS.Timeout | null = null;

  constructor(config: BotConfig['scanner']) {
    this.config = config;
    this.loadBlacklistFromDisk();
  }

  private getBlacklistPath(): string {
    return path.resolve(__dirname, '../../data_cache/blacklist.json');
  }

  private loadBlacklistFromDisk() {
    try {
      const p = this.getBlacklistPath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, '[]', 'utf-8');
        return;
      }
      const raw = fs.readFileSync(p, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const now = Date.now();
        for (const it of list) {
          if (it && it.symbol && (!it.expiresAt || it.expiresAt > now)) {
            this.blacklistMap.set(it.symbol, it);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  private saveBlacklistToDisk() {
    try {
      const p = this.getBlacklistPath();
      const arr = Array.from(this.blacklistMap.values());
      fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  private scheduleSaveBlacklist() {
    if (this.blacklistSaveTimer) return;
    this.blacklistSaveTimer = setTimeout(() => {
      this.blacklistSaveTimer = null;
      this.saveBlacklistToDisk();
    }, 1000);
  }

  public getBlacklist(): BlacklistEntry[] {
    const now = Date.now();
    let hasExpired = false;
    for (const [sym, entry] of this.blacklistMap.entries()) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.blacklistMap.delete(sym);
        hasExpired = true;
      }
    }
    if (hasExpired) this.scheduleSaveBlacklist();
    return Array.from(this.blacklistMap.values());
  }

  public isBlacklisted(symbol: string): boolean {
    const entry = this.blacklistMap.get(symbol);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.blacklistMap.delete(symbol);
      this.scheduleSaveBlacklist();
      return false;
    }
    return true;
  }

  public addTemporaryBlacklist(symbol: string, entry: Partial<BlacklistEntry>) {
    const now = Date.now();
    const existing = this.blacklistMap.get(symbol);
    const updated: BlacklistEntry = {
      symbol,
      reason: entry.reason || existing?.reason || 'Auto-blacklisted',
      vol24: entry.vol24 || existing?.vol24,
      addedAt: existing?.addedAt || now,
      expiresAt: entry.expiresAt || existing?.expiresAt || (now + ((this.config.blacklistTemporaryHours || 24) * 3600 * 1000)),
      auto: entry.auto ?? true,
    };
    this.blacklistMap.set(symbol, updated);
    this.scheduleSaveBlacklist();
    // Log yang lebih ringkas: hanya log saat scheduled refresh, tidak per-koin real-time
  }

  public removeBlacklist(symbol: string): boolean {
    const deleted = this.blacklistMap.delete(symbol);
    if (deleted) this.scheduleSaveBlacklist();
    return deleted;
  }

  public clearBlacklist(): void {
    this.blacklistMap.clear();
    this.saveBlacklistToDisk();
  }

  /**
   * Scheduled refresh: Re-check all tradable symbols and auto-blacklist those exceeding volume limit
   * Runs every 1 hour (called from engine)
   */
  public async refreshAutoBlacklist(): Promise<void> {
    if (!this.config.autoBlacklist || !this.config.max24hVolumeUsdt || this.config.max24hVolumeUsdt <= 0) {
      return;
    }

    try {
      const tickers = await binanceFutures.fetch24hTickers();
      let blacklistedCount = 0;

      for (const t of tickers) {
        const symbol = t.s || t.symbol;
        if (!symbol || !symbol.endsWith('USDT')) continue;
        if (this.isBlacklisted(symbol)) continue;

        const vol24 = parseFloat(t.q || '0');
        if (vol24 >= this.config.max24hVolumeUsdt) {
          const reason = `24h volume $${Math.round(vol24).toLocaleString('en-US')} >= limit $${this.config.max24hVolumeUsdt.toLocaleString('en-US')}`;
          this.addTemporaryBlacklist(symbol, {
            reason,
            vol24,
            auto: true,
          });
          blacklistedCount++;
        }
      }

      if (blacklistedCount > 0) {
        logger.log('INFO', `🔄 [AUTO BLACKLIST REFRESH] ${blacklistedCount} koin baru di-blacklist karena volume > $${this.config.max24hVolumeUsdt.toLocaleString('en-US')} USDT`);
      }
    } catch (err) {
      logger.log('ERROR', `❌ [AUTO BLACKLIST REFRESH] Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public getTotalMonitoredSymbols(): number {
    if (this.config.whitelistEnabled && this.config.whitelistSymbols && this.config.whitelistSymbols.length > 0) {
      return this.config.whitelistSymbols.length;
    }
    return this.lastPrices.size;
  }

  public getTicksPerSecond(): number {
    return this.lastDataAt > 0 && Date.now() - this.lastDataAt > 3000 ? 0 : this.ticksPerSecond;
  }

  public getDataAgeMs(): number {
    return this.lastDataAt > 0 ? Date.now() - this.lastDataAt : -1;
  }

  public updateConfig(newConfig: BotConfig['scanner']) {
    this.config = newConfig;
    if (this.config.whitelistEnabled && this.config.whitelistSymbols && this.config.whitelistSymbols.length > 0) {
      // Bersihkan koin yang tidak lagi ada di whitelist agar tidak tertinggal di cache scanner
      const allowed = new Set(this.config.whitelistSymbols);
      for (const sym of this.lastPrices.keys()) {
        if (!allowed.has(sym)) {
          this.lastPrices.delete(sym);
          this.priceHistory.delete(sym);
        }
      }
    }
    if (this.config.excludeSymbols && this.config.excludeSymbols.length > 0) {
      const excluded = new Set(this.config.excludeSymbols);
      for (const sym of this.lastPrices.keys()) {
        if (excluded.has(sym)) {
          this.lastPrices.delete(sym);
          this.priceHistory.delete(sym);
        }
      }
    }
  }

  public setCooldown(symbol: string, minutes: number) {
    const until = Date.now() + minutes * 60 * 1000;
    this.cooldowns.set(symbol, until);
  }

  public isCoolingDown(symbol: string): boolean {
    const until = this.cooldowns.get(symbol);
    if (!until) return false;
    if (Date.now() > until) {
      this.cooldowns.delete(symbol);
      return false;
    }
    return true;
  }

  public getCooldowns(): { symbol: string; until: number }[] {
    const now = Date.now();
    const result: { symbol: string; until: number }[] = [];
    for (const [sym, until] of this.cooldowns.entries()) {
      if (until > now) {
        result.push({ symbol: sym, until });
      } else {
        this.cooldowns.delete(sym);
      }
    }
    return result;
  }

  public getRecentSpikes(): SpikeAlert[] {
    return this.recentSpikes.slice(0, 30);
  }

  public setRecentSpikes(spikes: SpikeAlert[]) {
    this.recentSpikes = spikes;
  }

  public getCurrentPrice(symbol: string): number {
    return this.lastPrices.get(symbol) || 0;
  }

  public getStats() {
    return {
      trackedPairs: this.getTotalMonitoredSymbols(),
      ticksPerSecond: this.ticksPerSecond,
      activeCooldowns: this.cooldowns.size,
    };
  }

  public start() {
    binanceFutures.onTickers((tickers: any[]) => {
      this.processTickers(tickers);
    });
  }

  private processTickers(tickers: any[]) {
    if (!this.config.enabled) return;
    const now = Date.now();
    if (tickers.length > 0) this.lastDataAt = now;
    this.tickCount += tickers.length;
    if (now - this.lastTickReset >= 1000) {
      this.ticksPerSecond = this.tickCount;
      this.tickCount = 0;
      this.lastTickReset = now;
    }
    const lookbackMs = (this.config.spikeLookbackSeconds || 20) * 1000;

    for (const t of tickers) {
      const symbol = t.s;
      if (!symbol || !symbol.endsWith('USDT')) continue;
      if (this.config.excludeSymbols.includes(symbol)) continue;

      // Whitelist: Jika aktif, HANYA proses koin yang ada di daftar putih
      if (this.config.whitelistEnabled && this.config.whitelistSymbols && this.config.whitelistSymbols.length > 0) {
        if (!this.config.whitelistSymbols.includes(symbol)) continue;
      }

      // Filter Volume 24 Jam Minimal (Turnover USDT): Hanya saring koin aktif, buang koin mati suri/zombie
      if (this.config.min24hVolumeUsdt && this.config.min24hVolumeUsdt > 0 && t.q !== undefined) {
        const quoteVol24h = parseFloat(t.q || '0');
        if (quoteVol24h < this.config.min24hVolumeUsdt) {
          continue;
        }
      }

      // skip if already blacklisted
      if (this.isBlacklisted(symbol)) {
        continue;
      }

      // Auto-blacklist volume ekstrim (hanya jika autoBlacklist aktif & batas atas max24hVolumeUsdt diset > 0)
      if (this.config.autoBlacklist && this.config.max24hVolumeUsdt && this.config.max24hVolumeUsdt > 0) {
        const vol24 = parseFloat(t.q || '0');
        if (vol24 >= this.config.max24hVolumeUsdt) {
          const reason = `24h volume $${Math.round(vol24).toLocaleString('en-US')} >= limit $${this.config.max24hVolumeUsdt.toLocaleString('en-US')}`;
          this.addTemporaryBlacklist(symbol, {
            reason,
            vol24,
            auto: true,
          });
          // Notifikasi Telegram dihapus untuk menghindari spam, hanya log saat scheduled refresh
          continue;
        }
      }

      const currentPrice = parseFloat(t.c || t.p || '0');
      if (currentPrice <= 0) continue;
      if (currentPrice < this.config.minPriceUsdt || currentPrice > this.config.maxPriceUsdt) continue;

      this.lastPrices.set(symbol, currentPrice);

      // Simpan riwayat tick
      let history = this.priceHistory.get(symbol);
      if (!history) {
        history = [];
        this.priceHistory.set(symbol, history);
      }

      history.push({ symbol, price: currentPrice, time: now });

      // [OPTIMIZATION] Bulk slice data lama untuk menghindari Event Loop Lag (O(N) shift di-loop 2400x/dtk)
      const cutoffTime = now - lookbackMs - 10000;
      if (history.length > 0 && history[0].time < cutoffTime) {
        let spliceIndex = 0;
        for (let i = 0; i < history.length; i++) {
          if (history[i].time >= cutoffTime) {
            spliceIndex = i;
            break;
          }
        }
        if (spliceIndex > 0) {
          history = history.slice(spliceIndex);
          this.priceHistory.set(symbol, history);
        } else if (history[history.length - 1].time < cutoffTime) {
          history = [];
          this.priceHistory.set(symbol, history);
        }
      }

      // Cari harga tertua dalam jendela lookback
      const validPoints = history.filter((p) => p.time >= now - lookbackMs);
      if (validPoints.length < 2) continue;

      const startPrice = validPoints[0].price;
      if (startPrice <= 0) continue;

      const surgePct = ((currentPrice - startPrice) / startPrice) * 100;

      // Cek apakah lonjakan melampaui batas pemicu (Spike Trigger)
      if (surgePct >= this.config.spikeMinPercent) {
        // Cek apakah koin sedang cooldown
        if (this.isCoolingDown(symbol)) {
          continue;
        }

        // Filter Kenaikan 24 Jam (Mencegah Monster Parabolic Pump)
        if (this.config.max24hChangePct && this.config.max24hChangePct > 0) {
          const priceChange24h = parseFloat(t.P || '0');
          if (Math.abs(priceChange24h) > this.config.max24hChangePct) {
            const cooldownMins = this.config.cooldownMinutes || 10;
            this.setCooldown(symbol, cooldownMins);
            logger.log(
              'WARN',
              `🛡️ [MAX 24H SKIP] ${symbol} (+${surgePct.toFixed(2)}% dalam ${this.config.spikeLookbackSeconds}s): Dilewati karena perubahan 24 jam (${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(1)}%) melebihi batas aman (±${this.config.max24hChangePct}%). Menghindari monster pump parabolik (cooldown ${cooldownMins}m).`,
              symbol
            );
            continue;
          }
        }

        // Cek apakah spike untuk koin ini baru saja dibunyikan dalam 15 detik terakhir
        const recentAlert = this.recentSpikes.find((a) => a.symbol === symbol && now - a.timestamp < 15000);
        if (recentAlert) {
          continue;
        }

        const alert: SpikeAlert = {
          id: `${symbol}_${now}`,
          symbol,
          startPrice,
          currentPrice,
          surgePct: Math.round(surgePct * 100) / 100,
          lookbackSeconds: this.config.spikeLookbackSeconds,
          timestamp: now,
          status: 'PENDING',
        };

        this.recentSpikes.unshift(alert);
        if (this.recentSpikes.length > 50) this.recentSpikes.pop();

        for (const listener of this.alertListeners) {
          listener(alert);
        }
      }
    }
  }

  public onSpike(callback: (alert: SpikeAlert) => void) {
    this.alertListeners.push(callback);
  }
}
