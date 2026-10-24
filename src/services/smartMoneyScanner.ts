import { BotConfig, BtcTrendStatus, SmartMoneyConfig, SmartMoneySignal } from '../types';
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
  private lastPulseLogAt: number = 0;

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

      // Denyut Nadi Scanner Berkala (Setiap 2.5 Menit agar user tahu scanner berjalan aktif & transparan)
      const now = Date.now();
      if (now - this.lastPulseLogAt >= 150000) {
        this.lastPulseLogAt = now;
        const driver = this.config.signalDriver || 'SMART_TRADER';
        const driverName = driver === 'SMART_TRADER' ? 'SMART TRADER' : driver === 'DUAL_CONFLUENCE' ? 'DUAL CONFLUENCE' : 'PAUS';
        const targetPct = Math.round(Math.max(thresholdShort, thresholdLong) * 100);

        let topCoin = '';
        let topRatio = 0;
        let topSide = '';
        for (const sym of symbolsToScan) {
          const m = this.trackedMetrics.get(sym);
          if (!m) continue;
          if (driver === 'SMART_TRADER') {
            const sShort = m.smartTraderShortRatio || 0;
            const sLong = m.smartTraderLongRatio || 0;
            if (sShort > topRatio) { topRatio = sShort; topCoin = sym; topSide = 'Short'; }
            if (sLong > topRatio) { topRatio = sLong; topCoin = sym; topSide = 'Long'; }
          } else {
            const wShort = m.whaleShortRatio || 0;
            const wLong = m.whaleLongRatio || 0;
            if (wShort > topRatio) { topRatio = wShort; topCoin = sym; topSide = 'Short'; }
            if (wLong > topRatio) { topRatio = wLong; topCoin = sym; topSide = 'Long'; }
          }
        }

        const topInfo = topCoin && topRatio > 0
          ? `Akumulasi terdekat: ${topCoin} (${topSide} ${(topRatio * 100).toFixed(1)}%)`
          : 'Menganalisis arus order';

        logger.log(
          'INFO',
          `📡 [RADAR ${driverName}] Aktif memindai ${candidateSymbols.length} koin Futures | Batch rotasi ${symbolsToScan.length} koin (TF ${period}) | ${topInfo} | Syarat pemicu: >= ${targetPct}% | Status: Berjalan normal & siaga berburu sinyal...`
        );
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
      let smartTraderAligned = true;

      const driver = this.config.signalDriver || 'SMART_TRADER';
      const rawMinSmart = this.config.smartTraderMinRatio ?? 30;
      const minSmartRatio = rawMinSmart > 1 ? rawMinSmart / 100 : rawMinSmart;
      const rawMinWhale = this.config.minWhaleRatio ?? 30;
      const minWhaleRatio = rawMinWhale > 1 ? rawMinWhale / 100 : rawMinWhale;
      const isSmartFilterOn = this.config.smartTraderFilterEnabled !== false;

      const smartShort = metrics.smartTraderShortRatio ?? 0.5;
      const smartLong = metrics.smartTraderLongRatio ?? 0.5;
      const canShort = this.config.direction === 'BOTH' || this.config.direction === 'SHORT_ONLY';
      const canLong = this.config.direction === 'BOTH' || this.config.direction === 'LONG_ONLY';

      if (driver === 'SMART_TRADER') {
        // MODE 1: SMART TRADER DRIVEN (Default & Rekomendasi)
        // Mengikuti arah Top 20% Akun Trader Profit Binance (murni spekulasi cuan, bebas hedging spot paus)
        if (canShort && smartShort >= thresholdShort) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailLongRatio >= 0.50;
          const whaleAligned = !isSmartFilterOn || metrics.whaleShortRatio >= minWhaleRatio;

          if (!whaleAligned) {
            logger.log(
              'INFO',
              `🧠 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Smart Trader Short ${(smartShort * 100).toFixed(1)}% tapi Paus didominasi Long ${(metrics.whaleLongRatio * 100).toFixed(1)}% (Short hanya ${(metrics.whaleShortRatio * 100).toFixed(1)}% < min ${(minWhaleRatio * 100).toFixed(0)}%). Paus terlalu ekstrem berlawanan.`
            );
          } else if (isRetailTrapped) {
            detectedSide = 'SHORT';
            smartTraderAligned = true;
            reason = `Smart Trader Short ${(smartShort * 100).toFixed(1)}% | Paus Short ${(metrics.whaleShortRatio * 100).toFixed(1)}% | Retail Long ${(metrics.retailLongRatio * 100).toFixed(1)}%`;
          } else {
            logger.log(
              'INFO',
              `🧠 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Smart Trader Short ${(smartShort * 100).toFixed(1)}% tapi Retail tidak tersangkut Long (Retail Long hanya ${(metrics.retailLongRatio * 100).toFixed(1)}% < min 50%). Konfirmasi Retail Trap gagal.`
            );
          }
        }

        if (!detectedSide && canLong && smartLong >= thresholdLong) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailShortRatio >= 0.50;
          const whaleAligned = !isSmartFilterOn || metrics.whaleLongRatio >= minWhaleRatio;

          if (!whaleAligned) {
            logger.log(
              'INFO',
              `🧠 [SMART MONEY SKIP] ${symbol} LONG dilewati: Smart Trader Long ${(smartLong * 100).toFixed(1)}% tapi Paus didominasi Short ${(metrics.whaleShortRatio * 100).toFixed(1)}% (Long hanya ${(metrics.whaleLongRatio * 100).toFixed(1)}% < min ${(minWhaleRatio * 100).toFixed(0)}%). Paus terlalu ekstrem berlawanan.`
            );
          } else if (isRetailTrapped) {
            detectedSide = 'LONG';
            smartTraderAligned = true;
            reason = `Smart Trader Long ${(smartLong * 100).toFixed(1)}% | Paus Long ${(metrics.whaleLongRatio * 100).toFixed(1)}% | Retail Short ${(metrics.retailShortRatio * 100).toFixed(1)}%`;
          } else {
            logger.log(
              'INFO',
              `🧠 [SMART MONEY SKIP] ${symbol} LONG dilewati: Smart Trader Long ${(smartLong * 100).toFixed(1)}% tapi Retail tidak tersangkut Short (Retail Short hanya ${(metrics.retailShortRatio * 100).toFixed(1)}% < min 50%). Konfirmasi Retail Trap gagal.`
            );
          }
        }
      } else if (driver === 'DUAL_CONFLUENCE') {
        // MODE 2: DUAL CONFLUENCE (Wajib Paus dan Smart Trader searah di atas threshold)
        if (canShort && metrics.whaleShortRatio >= thresholdShort && smartShort >= thresholdShort) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailLongRatio >= 0.50;
          if (isRetailTrapped) {
            detectedSide = 'SHORT';
            smartTraderAligned = true;
            reason = `Dual Confluence Short: Paus ${(metrics.whaleShortRatio * 100).toFixed(1)}% + Smart Trader ${(smartShort * 100).toFixed(1)}% | Retail Long ${(metrics.retailLongRatio * 100).toFixed(1)}%`;
          } else {
            logger.log('INFO', `🎯 [DUAL CONFLUENCE SKIP] ${symbol} SHORT dilewati: Paus & Smart Trader Short, tapi Retail tidak tersangkut Long (${(metrics.retailLongRatio * 100).toFixed(1)}% < 50%).`);
          }
        }

        if (!detectedSide && canLong && metrics.whaleLongRatio >= thresholdLong && smartLong >= thresholdLong) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailShortRatio >= 0.50;
          if (isRetailTrapped) {
            detectedSide = 'LONG';
            smartTraderAligned = true;
            reason = `Dual Confluence Long: Paus ${(metrics.whaleLongRatio * 100).toFixed(1)}% + Smart Trader ${(smartLong * 100).toFixed(1)}% | Retail Short ${(metrics.retailShortRatio * 100).toFixed(1)}%`;
          } else {
            logger.log('INFO', `🎯 [DUAL CONFLUENCE SKIP] ${symbol} LONG dilewati: Paus & Smart Trader Long, tapi Retail tidak tersangkut Short (${(metrics.retailShortRatio * 100).toFixed(1)}% < 50%).`);
          }
        }
      } else {
        // MODE 3: WHALE DRIVEN (Mode Lama)
        if (canShort && metrics.whaleShortRatio >= thresholdShort) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailLongRatio >= 0.50;
          smartTraderAligned = smartShort >= minSmartRatio;

          if (isSmartFilterOn && !smartTraderAligned) {
            logger.log(
              'INFO',
              `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Paus Short ${(metrics.whaleShortRatio * 100).toFixed(1)}% tapi Smart Trader didominasi Long ${(smartLong * 100).toFixed(1)}% (Short hanya ${(smartShort * 100).toFixed(1)}% < min ${(minSmartRatio * 100).toFixed(0)}%). Divergent / Rawan Squeeze.`
            );
          } else if (isRetailTrapped) {
            detectedSide = 'SHORT';
            const smartTag = metrics.smartTraderShortRatio !== undefined
              ? ` | Smart Trader Short ${(smartShort * 100).toFixed(1)}%`
              : '';
            reason = `Whale Short ${(metrics.whaleShortRatio * 100).toFixed(1)}%${smartTag} | Retail Long ${(metrics.retailLongRatio * 100).toFixed(1)}%`;
          } else {
            logger.log('INFO', `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Paus Short ${(metrics.whaleShortRatio * 100).toFixed(1)}% tapi Retail tidak tersangkut Long (${(metrics.retailLongRatio * 100).toFixed(1)}% < 50%).`);
          }
        }

        if (!detectedSide && canLong && metrics.whaleLongRatio >= thresholdLong) {
          const isRetailTrapped = !this.config.retailTrapFilter || metrics.retailShortRatio >= 0.50;
          smartTraderAligned = smartLong >= minSmartRatio;

          if (isSmartFilterOn && !smartTraderAligned) {
            logger.log(
              'INFO',
              `🐋 [SMART MONEY SKIP] ${symbol} LONG dilewati: Paus Long ${(metrics.whaleLongRatio * 100).toFixed(1)}% tapi Smart Trader didominasi Short ${(smartShort * 100).toFixed(1)}% (Long hanya ${(smartLong * 100).toFixed(1)}% < min ${(minSmartRatio * 100).toFixed(0)}%). Divergent / Rawan Dump.`
            );
          } else if (isRetailTrapped) {
            detectedSide = 'LONG';
            const smartTag = metrics.smartTraderLongRatio !== undefined
              ? ` | Smart Trader Long ${(smartLong * 100).toFixed(1)}%`
              : '';
            reason = `Whale Long ${(metrics.whaleLongRatio * 100).toFixed(1)}%${smartTag} | Retail Short ${(metrics.retailShortRatio * 100).toFixed(1)}%`;
          } else {
            logger.log('INFO', `🐋 [SMART MONEY SKIP] ${symbol} LONG dilewati: Paus Long ${(metrics.whaleLongRatio * 100).toFixed(1)}% tapi Retail tidak tersangkut Short (${(metrics.retailShortRatio * 100).toFixed(1)}% < 50%).`);
          }
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
          const checkWhaleHealthShort = true;
          if (this.config.whaleHealthFilterEnabled !== false && checkWhaleHealthShort && whaleWinratePct !== undefined) {
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
            if (this.config.whaleHealthFilterEnabled !== false && checkWhaleHealthShort && currentPrice > whaleAvgEntry) {
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
            if (this.config.whaleDistanceFilterEnabled !== false && checkWhaleHealthShort) {
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
          const checkWhaleHealthLong = true;
          if (this.config.whaleHealthFilterEnabled !== false && checkWhaleHealthLong && whaleWinratePct !== undefined) {
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
            if (this.config.whaleHealthFilterEnabled !== false && checkWhaleHealthLong && currentPrice < whaleAvgEntry) {
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
            if (this.config.whaleDistanceFilterEnabled !== false && checkWhaleHealthLong) {
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

        // Filter RSI 15m: Mencegah Short di dasar jurang (oversold), Long di pucuk, dan Short koin yang sedang pumping liar
        if (this.config.rsiFilterEnabled !== false) {
          const rsi = await binanceFutures.getSymbolRsi(symbol, '15m');
          if (rsi !== undefined) {
            const minRsiShort = this.config.minRsiShort ?? 48;
            const maxRsiShort = this.config.maxRsiShort ?? 65;
            const maxRsiLong = this.config.maxRsiLong ?? 62;

            if (detectedSide === 'SHORT' && rsi < minRsiShort) {
              logger.log('INFO', `🐋 [SMART MONEY SKIP] ${symbol} SHORT dilewati: RSI 15m (${rsi}) < ${minRsiShort} (Koin sudah oversold di dasar jurang).`);
              return;
            }
            if (detectedSide === 'SHORT' && rsi > maxRsiShort) {
              logger.log(
                'INFO',
                `🛡️ [RSI SHORT SKIP] ${symbol} SHORT dilewati: RSI 15m (${rsi}) > ${maxRsiShort} (Koin sedang overbought / parabolic pump, dilarang short agar tidak tergulung squeeze).`
              );
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

        // Filter Funding Rate: Cegah Short saat Negative Funding Squeeze & Long saat pasar Overheated
        if (this.config.fundingRateFilterEnabled !== false) {
          const fundingPct = await binanceFutures.getFundingRate(symbol);
          if (fundingPct !== undefined) {
            const minFrShort = this.config.minFundingRatePct ?? -0.02; // Default -0.02%
            const maxFrLong = this.config.maxFundingRatePct ?? 0.10;   // Default +0.10%

            if (detectedSide === 'SHORT' && fundingPct < minFrShort) {
              logger.log(
                'INFO',
                `🛡️ [FUNDING RATE SKIP] ${symbol} SHORT dilewati: Funding Rate (${fundingPct.toFixed(4)}%) < min ${minFrShort}%. Pasar crowded short & rawan short squeeze bandar.`
              );
              return;
            }

            if (detectedSide === 'LONG' && fundingPct > maxFrLong) {
              logger.log(
                'INFO',
                `🛡️ [FUNDING RATE SKIP] ${symbol} LONG dilewati: Funding Rate (${fundingPct.toFixed(4)}%) > max ${maxFrLong}%. Biaya Long terlalu mahal & rawan long flush.`
              );
              return;
            }

            reason += ` | Funding: ${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}%`;
          }
        }

        // Filter Konfirmasi Tren EMA (e.g. EMA 50 pada timeframe 15m)
        if (this.config.emaFilterEnabled) {
          const emaTf = this.config.emaTimeframe || '15m';
          const emaPeriod = this.config.emaPeriod || 50;
          const emaVal = await binanceFutures.getSymbolEma(symbol, emaTf, emaPeriod);
          if (emaVal !== undefined) {
            if (detectedSide === 'LONG' && currentPrice < emaVal) {
              logger.log(
                'INFO',
                `📈 [SMART MONEY SKIP] ${symbol} LONG dilewati: Harga ($${formatCryptoPrice(currentPrice)}) masih di bawah EMA ${emaPeriod} ${emaTf} ($${formatCryptoPrice(emaVal)}). Belum terkonfirmasi bullish reclaim.`
              );
              return;
            }
            if (detectedSide === 'SHORT' && currentPrice > emaVal) {
              logger.log(
                'INFO',
                `📉 [SMART MONEY SKIP] ${symbol} SHORT dilewati: Harga ($${formatCryptoPrice(currentPrice)}) masih di atas EMA ${emaPeriod} ${emaTf} ($${formatCryptoPrice(emaVal)}). Belum terkonfirmasi bearish rejection.`
              );
              return;
            }
            reason += ` | EMA ${emaPeriod} ${emaTf}: $${formatCryptoPrice(emaVal)}`;
          }
        }

        // Filter Pelindung Tren Macro BTC (Anti-Dump & Anti-Pump Market Wide)
        let btcTrendStatus: BtcTrendStatus | null = null;
        if (this.config.btcTrendFilterEnabled !== false) {
          const btcTf = this.config.btcTrendTimeframe || '1h';
          const btcPeriod = this.config.btcTrendEmaPeriod || 50;
          const dropThresh = this.config.btcDropThresholdPct ?? 1.0;
          btcTrendStatus = await binanceFutures.getBtcTrendStatus(btcTf, btcPeriod, dropThresh);

          if (btcTrendStatus) {
            if (detectedSide === 'LONG' && !btcTrendStatus.canLong) {
              const dumpDetail = btcTrendStatus.isFlashDump ? ' (FLASH DUMP)' : '';
              logger.log(
                'INFO',
                `🛡️ [BTC GUARD SKIP] ${symbol} LONG dibatalkan: BTC sedang ${btcTrendStatus.trend}${dumpDetail} ($${btcTrendStatus.btcPrice.toFixed(0)} vs EMA${btcPeriod} $${btcTrendStatus.ema.toFixed(0)}, 1-candle Δ: ${btcTrendStatus.changePct >= 0 ? '+' : ''}${btcTrendStatus.changePct.toFixed(2)}%). Menghindari risiko pisau jatuh pasar.`
              );
              return;
            }

            if (detectedSide === 'SHORT' && !btcTrendStatus.canShort) {
              const surgeDetail = btcTrendStatus.isFlashSurge ? ' (FLASH SURGE)' : '';
              logger.log(
                'INFO',
                `🛡️ [BTC GUARD SKIP] ${symbol} SHORT dibatalkan: BTC sedang ${btcTrendStatus.trend}${surgeDetail} ($${btcTrendStatus.btcPrice.toFixed(0)} vs EMA${btcPeriod} $${btcTrendStatus.ema.toFixed(0)}, 1-candle Δ: ${btcTrendStatus.changePct >= 0 ? '+' : ''}${btcTrendStatus.changePct.toFixed(2)}%). Menghindari risiko kena squeeze pump pasar.`
              );
              return;
            }

            reason += ` | BTC ${btcTrendStatus.trend} ($${btcTrendStatus.btcPrice.toFixed(0)}/EMA $${btcTrendStatus.ema.toFixed(0)})`;
          }
        }

        const signalId = `sm_${symbol}_${Date.now()}`;
        const signal: SmartMoneySignal = {
          id: signalId,
          symbol,
          side: detectedSide,
          signalDriver: driver,
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
          smartTraderLongRatio: metrics.smartTraderLongRatio,
          smartTraderShortRatio: metrics.smartTraderShortRatio,
          smartTraderLongAvgEntry: metrics.smartTraderLongAvgEntry,
          smartTraderShortAvgEntry: metrics.smartTraderShortAvgEntry,
          smartTraderAligned,
          atr: atrData?.atr,
          atrPct: atrData?.atrPct,
          btcTrendStatus: btcTrendStatus
            ? {
                btcPrice: btcTrendStatus.btcPrice,
                ema: btcTrendStatus.ema,
                trend: btcTrendStatus.trend,
                changePct: btcTrendStatus.changePct,
              }
            : undefined,
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
