import { BotConfig, SmartMoneyConfig, SmartMoneySignal } from '../types';
import { binanceFutures } from './binance';
import { logger } from './logger';

export class SmartMoneyScanner {
  private config: SmartMoneyConfig;
  private botScannerConfig?: BotConfig['scanner'];
  private isScanning: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private signalListeners: ((signal: SmartMoneySignal) => void)[] = [];
  private cooldowns: Map<string, number> = new Map(); // symbol -> epochMs
  private trackedMetrics: Map<string, any> = new Map();
  private lastPrices: Map<string, number> = new Map();
  private tickerVol24h: Map<string, number> = new Map();
  private scanCursor: number = 0;

  constructor(config: SmartMoneyConfig, botScannerConfig?: BotConfig['scanner']) {
    this.config = config;
    this.botScannerConfig = botScannerConfig;
  }

  public updateConfig(config: SmartMoneyConfig, botScannerConfig?: BotConfig['scanner']) {
    this.config = config;
    if (botScannerConfig) {
      this.botScannerConfig = botScannerConfig;
    }
  }

  public onSignal(callback: (signal: SmartMoneySignal) => void) {
    this.signalListeners.push(callback);
  }

  public setPrice(symbol: string, price: number) {
    if (price > 0) {
      this.lastPrices.set(symbol, price);
    }
  }

  public setPrices(tickers: any[]) {
    for (const t of tickers) {
      const p = parseFloat(t.c || t.p || '0');
      if (p > 0) {
        this.lastPrices.set(t.s, p);
      }
      if (t.q) {
        const qVol = parseFloat(t.q);
        if (qVol > 0) {
          this.tickerVol24h.set(t.s, qVol);
        }
      }
    }
  }

  public isCoolingDown(symbol: string): boolean {
    const expiresAt = this.cooldowns.get(symbol);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
      this.cooldowns.delete(symbol);
      return false;
    }
    return true;
  }

  public setCooldown(symbol: string, minutes: number) {
    const ms = Math.max(1, minutes) * 60 * 1000;
    this.cooldowns.set(symbol, Date.now() + ms);
  }

  public getTrackedMetrics(): any[] {
    return Array.from(this.trackedMetrics.values());
  }

  public start() {
    if (this.isScanning) return;
    this.isScanning = true;
    const intervalMs = Math.max(15, this.config.scanIntervalSeconds || 30) * 1000;
    
    // Scan awal setelah 3 detik
    setTimeout(() => {
      if (this.isScanning) {
        this.runScanCycle().catch(() => {});
      }
    }, 3000);

    this.scanTimer = setInterval(() => {
      this.runScanCycle().catch(() => {});
    }, intervalMs);

    logger.log('INFO', `🐋 [SMART MONEY SCANNER] Aktif. Interval pemindaian: ${intervalMs / 1000}s | Periode: ${this.config.period || '5m'}`);
  }

  public stop() {
    this.isScanning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * Menjalankan 1 siklus pemindaian koin untuk mendeteksi dominasi Smart Money
   */
  public async runScanCycle() {
    if (!this.config.enabled) return;

    try {
      // Ambil koin yang dapat diperdagangkan dari Binance Futures
      const allSymbols = await binanceFutures.getTradableSymbols();
      if (!allSymbols || allSymbols.length === 0) return;

      // Filter pengecualian dan whitelist jika ada
      let candidateSymbols = allSymbols.filter(s => s.endsWith('USDT'));
      if (this.botScannerConfig?.excludeSymbols && this.botScannerConfig.excludeSymbols.length > 0) {
        const excludeSet = new Set(this.botScannerConfig.excludeSymbols.map(s => s.toUpperCase()));
        candidateSymbols = candidateSymbols.filter(s => !excludeSet.has(s));
      }

      if (this.botScannerConfig?.whitelistEnabled && this.botScannerConfig.whitelistSymbols && this.botScannerConfig.whitelistSymbols.length > 0) {
        const whiteSet = new Set(this.botScannerConfig.whitelistSymbols.map(s => s.toUpperCase()));
        candidateSymbols = candidateSymbols.filter(s => whiteSet.has(s));
      }

      // Filter volume minimal 24 jam & sortir dari volume tertinggi (Paling Likuid/Institusional)
      const minVol = this.botScannerConfig?.min24hVolumeUsdt || 1_000_000;
      if (this.tickerVol24h.size > 0) {
        const filtered = candidateSymbols.filter(s => (this.tickerVol24h.get(s) || 0) >= minVol);
        if (filtered.length > 0) {
          candidateSymbols = filtered;
        }
        candidateSymbols.sort((a, b) => (this.tickerVol24h.get(b) || 0) - (this.tickerVol24h.get(a) || 0));
      }

      // Ambil batch berputar (rotating window) agar seluruh koin likuid terpindai secara merata
      const maxSymbols = 25;
      const startIndex = this.scanCursor % Math.max(1, candidateSymbols.length);
      let symbolsToScan = candidateSymbols.slice(startIndex, startIndex + maxSymbols);
      if (symbolsToScan.length < maxSymbols && candidateSymbols.length > maxSymbols) {
        symbolsToScan = symbolsToScan.concat(candidateSymbols.slice(0, maxSymbols - symbolsToScan.length));
      }
      this.scanCursor = (this.scanCursor + maxSymbols) % Math.max(1, candidateSymbols.length);

      const period = this.config.period || '5m';
      const thresholdShort = this.config.thresholdShortRatio || 0.60;
      const thresholdLong = this.config.thresholdLongRatio || 0.60;

      for (const symbol of symbolsToScan) {
        if (this.isCoolingDown(symbol)) continue;

        const metrics = await binanceFutures.getSmartMoneyMetrics(symbol, period);
        if (!metrics) continue;

        this.trackedMetrics.set(symbol, metrics);

        const currentPrice = this.lastPrices.get(symbol) || 0;
        if (currentPrice <= 0) continue;

        let detectedSide: 'SHORT' | 'LONG' | null = null;
        let reason = '';

        // Deteksi Sinyal SHORT: Whale Short >= threshold (misal 60%)
        if (
          (this.config.direction === 'BOTH' || this.config.direction === 'SHORT_ONLY') &&
          metrics.whaleShortRatio >= thresholdShort
        ) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailLongRatio >= 0.50;
          if (isRetailTrapped) {
            detectedSide = 'SHORT';
            reason = `Whale Short ${(metrics.whaleShortRatio * 100).toFixed(1)}% | Retail Long ${(metrics.retailLongRatio * 100).toFixed(1)}%`;
          }
        }

        // Deteksi Sinyal LONG: Whale Long >= threshold (misal 60%)
        if (
          !detectedSide &&
          (this.config.direction === 'BOTH' || this.config.direction === 'LONG_ONLY') &&
          metrics.whaleLongRatio >= thresholdLong
        ) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailShortRatio >= 0.50;
          if (isRetailTrapped) {
            detectedSide = 'LONG';
            reason = `Whale Long ${(metrics.whaleLongRatio * 100).toFixed(1)}% | Retail Short ${(metrics.retailShortRatio * 100).toFixed(1)}%`;
          }
        }

        if (detectedSide) {
          const signalId = `sm_${symbol}_${Date.now()}`;
          const signal: SmartMoneySignal = {
            id: signalId,
            symbol,
            side: detectedSide,
            currentPrice,
            triggerPrice: currentPrice,
            whaleLongRatio: metrics.whaleLongRatio,
            whaleShortRatio: metrics.whaleShortRatio,
            whaleLongShortRatio: metrics.whaleLongShortRatio,
            retailLongRatio: metrics.retailLongRatio,
            retailShortRatio: metrics.retailShortRatio,
            timestamp: Date.now(),
            status: 'PENDING',
            reason,
          };

          this.emitSignal(signal);
        }
      }
    } catch (e: any) {
      logger.log('INFO', `[SMART MONEY SCAN] Gagal memindai: ${e?.message || e}`);
    }
  }

  private emitSignal(signal: SmartMoneySignal) {
    for (const listener of this.signalListeners) {
      try {
        listener(signal);
      } catch (err: any) {
        logger.log('ERROR', `[SMART MONEY LISTENER ERROR] ${err?.message || err}`);
      }
    }
  }
}
