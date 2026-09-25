import { BotConfig, SpikeAlert, TickerSnapshot } from '../types';
import { binanceFutures } from './binance';

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

  constructor(config: BotConfig['scanner']) {
    this.config = config;
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
