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

  constructor(config: BotConfig['scanner']) {
    this.config = config;
  }

  public getTotalMonitoredSymbols(): number {
    return this.lastPrices.size;
  }

  public getTicksPerSecond(): number {
    return this.ticksPerSecond;
  }

  public updateConfig(newConfig: BotConfig['scanner']) {
    this.config = newConfig;
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

      // Buang data yang lebih tua dari lookbackMs + 10s
      while (history.length > 0 && history[0].time < now - lookbackMs - 10000) {
        history.shift();
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
