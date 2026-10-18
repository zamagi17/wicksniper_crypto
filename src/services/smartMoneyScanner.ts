import { BotConfig, SmartMoneyConfig, SmartMoneySignal } from '../types';
import { binanceFutures } from './binance';
import { logger } from './logger';

function formatCryptoPrice(val: number): string {
  if (val === 0) return '0.00';
  const abs = Math.abs(val);
  if (abs >= 1000) return val.toFixed(2);
  if (abs >= 1) return val.toFixed(4);
  if (abs >= 0.001) return val.toFixed(6);
  return val.toFixed(8);
}

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

      const CHUNK_SIZE = 3;
      for (let i = 0; i < symbolsToScan.length; i += CHUNK_SIZE) {
        if (!this.isScanning) break;
        const chunk = symbolsToScan.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map((symbol) => this.scanSymbol(symbol, period, thresholdShort, thresholdLong))
        );
        if (i + CHUNK_SIZE < symbolsToScan.length) {
          await new Promise((r) => setTimeout(r, 120));
        }
      }
    } catch (e: any) {
      logger.log('INFO', `[SMART MONEY SCAN] Gagal memindai: ${e?.message || e}`);
    }
  }

  /**
   * Pindai satu koin kandidat secara terisolasi untuk sinyal dominasi Smart Money
   */
  private async scanSymbol(
    symbol: string,
    period: string,
    thresholdShort: number,
    thresholdLong: number
  ) {
    if (this.isCoolingDown(symbol)) return;

    try {
      const metrics = await binanceFutures.getSmartMoneyMetrics(symbol, period);
      if (!metrics) return;

      this.trackedMetrics.set(symbol, metrics);

      const currentPrice = this.lastPrices.get(symbol) || 0;
      if (currentPrice <= 0) return;

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
        // Filter Jarak & Kesehatan Modal Paus (Sweet Spot Guard)
        let whaleAvgEntry: number | undefined;
        let whaleDistancePct: number | undefined;
        let whalePositionsUsdt: number | undefined;
        let whaleWinratePct: number | undefined;
        let whaleProfitWhales: number | undefined;
        let whaleTotalWhales: number | undefined;

        if (detectedSide === 'SHORT') {
          whalePositionsUsdt = metrics.shortWhalePositionsUsdt;
          whaleWinratePct = metrics.shortWhaleWinratePct;
          whaleProfitWhales = metrics.shortProfitWhales;
          whaleTotalWhales = metrics.shortWhales;

          // 1. Cek Filter Kesehatan Paus (% Meraih Laba)
          if (this.config.whaleHealthFilterEnabled !== false && whaleWinratePct !== undefined) {
            const minWinrate = this.config.minWhaleWinratePct ?? 50;
            if (whaleWinratePct < minWinrate) {
              logger.log(
                'INFO',
                `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Paus Short mayoritas sedang nyangkut/boncos (${whaleWinratePct.toFixed(1)}% laba [${whaleProfitWhales ?? 0}/${whaleTotalWhales ?? 0} paus] < min ${minWinrate}%). Rawan short squeeze.`
              );
              return;
            }
          }

          if (metrics.whaleShortAvgEntry && metrics.whaleShortAvgEntry > 0) {
            whaleAvgEntry = metrics.whaleShortAvgEntry;
            const distanceDropPct = ((whaleAvgEntry - currentPrice) / whaleAvgEntry) * 100;
            whaleDistancePct = -distanceDropPct;

            // 2. Cek Anti-Squeeze (Harga tidak boleh menembus modal paus ke arah rugi)
            if (this.config.whaleHealthFilterEnabled !== false && currentPrice > whaleAvgEntry) {
              const adverseLossPct = ((currentPrice - whaleAvgEntry) / whaleAvgEntry) * 100;
              const maxAdverse = this.config.maxWhaleAdverseLossPct ?? 0.8;
              if (adverseLossPct > maxAdverse) {
                logger.log(
                  'INFO',
                  `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Harga ($${formatCryptoPrice(currentPrice)}) berada +${adverseLossPct.toFixed(2)}% di atas modal Paus Short ($${formatCryptoPrice(whaleAvgEntry)}). Paus Short sedang tertekan rugi / terjepit (Batas maks: ${maxAdverse}%).`
                );
                return;
              }
            }

            // 3. Cek Anti-FOMO (Harga tidak boleh sudah anjlok terlalu jauh ke bawah)
            if (this.config.whaleDistanceFilterEnabled !== false) {
              const maxDist = this.config.maxWhaleDistancePct ?? 1.5;
              if (distanceDropPct > maxDist) {
                logger.log(
                  'INFO',
                  `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Harga ($${formatCryptoPrice(currentPrice)}) sudah anjlok -${distanceDropPct.toFixed(1)}% di bawah modal Paus Short ($${formatCryptoPrice(whaleAvgEntry)}). Melebihi batas aman maks ${maxDist}%. Rawan bounce.`
                );
                return;
              }
            }

            reason += ` | Modal Paus: $${formatCryptoPrice(whaleAvgEntry)} (Jarak: ${distanceDropPct >= 0 ? '-' : '+'}${Math.abs(distanceDropPct).toFixed(1)}%)`;
          }

          if (whaleWinratePct !== undefined) {
            reason += ` | Laba: ${whaleWinratePct.toFixed(0)}% (${whaleProfitWhales ?? 0}/${whaleTotalWhales ?? 0})`;
          }
        } else {
          whalePositionsUsdt = metrics.longWhalePositionsUsdt;
          whaleWinratePct = metrics.longWhaleWinratePct;
          whaleProfitWhales = metrics.longProfitWhales;
          whaleTotalWhales = metrics.longWhales;

          // 1. Cek Filter Kesehatan Paus (% Meraih Laba)
          if (this.config.whaleHealthFilterEnabled !== false && whaleWinratePct !== undefined) {
            const minWinrate = this.config.minWhaleWinratePct ?? 50;
            if (whaleWinratePct < minWinrate) {
              logger.log(
                'INFO',
                `🐋 [SMART MONEY SKIP] ${symbol} LONG dilewati: Paus Long mayoritas sedang nyangkut/boncos (${whaleWinratePct.toFixed(1)}% laba [${whaleProfitWhales ?? 0}/${whaleTotalWhales ?? 0} paus] < min ${minWinrate}%). Rawan dump lanjutan.`
              );
              return;
            }
          }

          if (metrics.whaleLongAvgEntry && metrics.whaleLongAvgEntry > 0) {
            whaleAvgEntry = metrics.whaleLongAvgEntry;
            const distanceSurgePct = ((currentPrice - whaleAvgEntry) / whaleAvgEntry) * 100;
            whaleDistancePct = distanceSurgePct;

            // 2. Cek Anti-Dumping (Harga tidak boleh anjlok di bawah modal paus ke arah rugi)
            if (this.config.whaleHealthFilterEnabled !== false && currentPrice < whaleAvgEntry) {
              const adverseLossPct = ((whaleAvgEntry - currentPrice) / whaleAvgEntry) * 100;
              const maxAdverse = this.config.maxWhaleAdverseLossPct ?? 0.8;
              if (adverseLossPct > maxAdverse) {
                logger.log(
                  'INFO',
                  `🐋 [SMART MONEY SKIP] ${symbol} LONG dilewati: Harga ($${formatCryptoPrice(currentPrice)}) anjlok -${adverseLossPct.toFixed(2)}% di bawah modal Paus Long ($${formatCryptoPrice(whaleAvgEntry)}). Paus Long sedang tertekan rugi / dumping (Batas maks: ${maxAdverse}%).`
                );
                return;
              }
            }

            // 3. Cek Anti-FOMO (Harga tidak boleh sudah terbang terlalu tinggi di atas)
            if (this.config.whaleDistanceFilterEnabled !== false) {
              const maxDist = this.config.maxWhaleDistancePct ?? 1.5;
              if (distanceSurgePct > maxDist) {
                logger.log(
                  'INFO',
                  `🐋 [SMART MONEY SKIP] ${symbol} LONG dilewati: Harga ($${formatCryptoPrice(currentPrice)}) sudah terbang +${distanceSurgePct.toFixed(1)}% di atas modal Paus Long ($${formatCryptoPrice(whaleAvgEntry)}). Melebihi batas aman maks ${maxDist}%. Rawan distribusi/pucuk.`
                );
                return;
              }
            }

            reason += ` | Modal Paus: $${formatCryptoPrice(whaleAvgEntry)} (Jarak: +${distanceSurgePct.toFixed(1)}%)`;
          }

          if (whaleWinratePct !== undefined) {
            reason += ` | Laba: ${whaleWinratePct.toFixed(0)}% (${whaleProfitWhales ?? 0}/${whaleTotalWhales ?? 0})`;
          }
        }

        // Filter RSI 15m: Mencegah Short di dasar jurang (oversold) & Long di pucuk (overbought)
        if (this.config.rsiFilterEnabled !== false) {
          const rsi = await binanceFutures.getSymbolRsi(symbol, '15m');
          if (rsi !== undefined) {
            const minRsiShort = this.config.minRsiShort ?? 48;
            const maxRsiLong = this.config.maxRsiLong ?? 62;

            if (detectedSide === 'SHORT' && rsi < minRsiShort) {
              logger.log('INFO', `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: RSI 15m (${rsi}) < ${minRsiShort} (Koin sudah oversold di dasar jurang).`);
              return;
            }
            if (detectedSide === 'LONG' && rsi > maxRsiLong) {
              logger.log('INFO', `🐋 [SMART MONEY SKIP] ${symbol} LONG dilewati: RSI 15m (${rsi}) > ${maxRsiLong} (Koin sudah overbought di pucuk gunung).`);
              return;
            }
            reason += ` | RSI 15m: ${rsi}`;
          }
        }

        // Filter ATR Volatilitas: Cegah koin mati gaya (sideways) & koin volatilitas liar tak terkendali
        let atrData: { atr: number; atrPct: number; currentPrice: number } | undefined;
        if (this.config.atrFilterEnabled !== false) {
          const tf = this.config.atrTimeframe || '15m';
          const period = this.config.atrPeriod || 14;
          atrData = await binanceFutures.getSymbolAtr(symbol, tf, period);
          if (atrData && atrData.atrPct !== undefined) {
            const minAtr = this.config.minAtrPct ?? 0.8;
            const maxAtr = this.config.maxAtrPct ?? 3.0;
            if (atrData.atrPct < minAtr) {
              logger.log(
                'INFO',
                `🐋 [SMART MONEY SKIP] ${symbol} ${detectedSide} dilewati: ATR ${tf} (${atrData.atrPct.toFixed(2)}%) < ${minAtr}% (Koin sedang flat/sideways mati gaya, target TP rawan gagal/lama).`
              );
              return;
            }
            if (atrData.atrPct > maxAtr) {
              logger.log(
                'INFO',
                `🐋 [SMART MONEY SKIP] ${symbol} ${detectedSide} dilewati: ATR ${tf} (${atrData.atrPct.toFixed(2)}%) > ${maxAtr}% (Volatilitas terlalu liar & berbahaya).`
              );
              return;
            }
            reason += ` | ATR ${tf}: ${atrData.atrPct.toFixed(2)}% ($${formatCryptoPrice(atrData.atr)})`;
          }
        }

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
          whaleAvgEntry,
          whaleDistancePct,
          whalePositionsUsdt,
          whaleWinratePct,
          whaleProfitWhales,
          whaleTotalWhales,
          atr: atrData?.atr,
          atrPct: atrData?.atrPct,
          timestamp: Date.now(),
          status: 'PENDING',
          reason,
        };

        this.emitSignal(signal);
      }
    } catch (err: any) {
      // Isolasi error per koin agar tidak mengganggu koin lain
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
