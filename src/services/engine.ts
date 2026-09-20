import fs from 'fs';
import path from 'path';
import { ActivePosition, BotConfig, ClosedTrade, EngineStatus, GridLayer, SpikeAlert } from '../types';
import { binanceFutures } from './binance';
import { SpikeScanner } from './scanner';
import { logger } from './logger';
import { db } from './db';

export class WickSniperEngine {
  private config: BotConfig;
  private configPath: string;
  private isRunning: boolean = false;
  private scanner: SpikeScanner;
  private virtualBalance: number = 1000;
  private activePositions: Map<string, ActivePosition> = new Map();
  private closedTrades: ClosedTrade[] = [];
  private spikesDetectedToday: number = 0;
  private statusListeners: ((status: EngineStatus) => void)[] = [];
  private configListeners: ((config: BotConfig) => void)[] = [];
  private lastSyncedConfigJson: string = '';
  private tickInterval: NodeJS.Timeout | null = null;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.virtualBalance = this.config.paperTrading?.initialVirtualBalance || 1000;
    this.scanner = new SpikeScanner(this.config.scanner);
    this.initListeners();
  }

  private loadConfig(): BotConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e: any) {
      console.error('Gagal memuat config:', e.message);
    }
    return {
      tradingMode: 'PAPER',
      apiKey: '',
      apiSecret: '',
      isTestnet: false,
      leverage: 5,
      marginType: 'CROSSED',
      scanner: {
        enabled: true,
        spikeLookbackSeconds: 20,
        spikeMinPercent: 2.5,
        volumeSpikeMultiplier: 2.0,
        minPriceUsdt: 0.005,
        maxPriceUsdt: 2000,
        excludeSymbols: ['USDCUSDT', 'FDUSDUSDT', 'BTCUSDT', 'ETHUSDT'],
        cooldownMinutes: 10,
      },
      grid: {
        maxConcurrentCoins: 2,
        totalLayers: 6,
        layerSpacingPct: 0.6,
        marginPerLayerUsdt: 10.0,
        martingaleMultiplier: 1.15,
        maxTotalMarginPerCoin: 80.0,
      },
      exit: {
        takeProfitPct: 1.2,
        trailingTpEnabled: true,
        trailingCallbackPct: 0.4,
        hardStopLossPct: 4.5,
        maxHoldMinutes: 10,
      },
      paperTrading: {
        initialVirtualBalance: 1000.0,
      },
      server: {
        port: 3005,
      },
    };
  }

  public saveConfig(newConfig: Partial<BotConfig>): BotConfig {
    this.config = { ...this.config, ...newConfig };
    this.scanner.updateConfig(this.config.scanner);
    if (this.config.apiKey && this.config.apiSecret) {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
    }
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.log('INFO', '⚙️ Konfigurasi Wick Sniper berhasil diperbarui.');
    } catch (e: any) {
      logger.log('ERROR', `Gagal menyimpan konfigurasi: ${e.message}`);
    }
    this.lastSyncedConfigJson = JSON.stringify(this.config);
    db.saveConfig(this.config).catch(() => {});
    this.broadcastConfig();
    this.broadcastStatus();
    return this.config;
  }

  public getConfig(): BotConfig {
    return this.config;
  }

  private initListeners() {
    this.scanner.onSpike((alert: SpikeAlert) => {
      this.handleSpikeAlert(alert);
    });

    binanceFutures.onTickers((tickers: any[]) => {
      this.onPriceTick(tickers);
    });
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await db.init();
    if (db.isConnected) {
      const dbCfg = await db.loadConfig();
      if (dbCfg) {
        this.config = { ...this.config, ...dbCfg };
        this.scanner.updateConfig(this.config.scanner);
        this.lastSyncedConfigJson = JSON.stringify(dbCfg);
      } else {
        await db.saveConfig(this.config);
        this.lastSyncedConfigJson = JSON.stringify(this.config);
      }
      const dbState = await db.loadState();
      if (dbState) {
        this.virtualBalance = dbState.virtualBalance;
        this.spikesDetectedToday = dbState.spikesToday || 0;
        if (dbState.activePositions && dbState.activePositions.length > 0) {
          for (const pos of dbState.activePositions) {
            this.activePositions.set(pos.symbol, pos);
          }
        }
      }
      const dbTrades = await db.loadRecentTrades(50);
      if (dbTrades.length > 0) {
        this.closedTrades = dbTrades;
      }
    }

    logger.log('SUCCESS', `🚀 [WICK SNIPER ENGINE AKTIF] Mode: ${this.config.tradingMode} | Leverage: ${this.config.leverage}x`);
    logger.log('INFO', `🎯 Target Spike: >= +${this.config.scanner.spikeMinPercent}% dalam ${this.config.scanner.spikeLookbackSeconds}s | TP: ${this.config.exit.takeProfitPct}% | Hard SL: ${this.config.exit.hardStopLossPct}%`);

    await binanceFutures.syncTime();
    await binanceFutures.loadExchangeInfo();
    binanceFutures.startFastTickerStream();
    await binanceFutures.startTickerWebSocket();
    this.scanner.start();

    // Heartbeat ticker, time-limit check tiap 1 detik, & sinkronisasi DB tiap 5 detik
    let tickCount = 0;
    this.tickInterval = setInterval(async () => {
      this.checkTimeLimitsAndTrailing();
      this.broadcastStatus();
      tickCount++;
      if (tickCount % 5 === 0) {
        await this.syncConfigFromDb();
      }
    }, 1000);
  }

  public stop() {
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    logger.log('WARN', '🛑 Wick Sniper Engine dinonaktifkan.');
    this.broadcastStatus();
  }

  /**
   * Menangani Spike Lonjakan Harga yang baru saja dideteksi Scanner
   */
  private async handleSpikeAlert(alert: SpikeAlert) {
    if (!this.isRunning) return;
    this.spikesDetectedToday++;

    const symbol = alert.symbol;

    // Cek kuota posisi aktif
    if (this.activePositions.size >= this.config.grid.maxConcurrentCoins) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Maksimal posisi aktif (${this.config.grid.maxConcurrentCoins}) tercapai`;
      logger.log('WARN', `⚡ Spike terdeteksi pada ${symbol} (+${alert.surgePct}%), namun dilewati: Kuota koin penuh.`);
      return;
    }

    // Cek apakah koin ini sudah memiliki posisi aktif
    if (this.activePositions.has(symbol)) {
      return;
    }

    alert.status = 'EXECUTING';
    logger.log('SNIPER', `🚨 [SPONGE SPIKE DETECTED] ${symbol} melonjak +${alert.surgePct}% dalam ${alert.lookbackSeconds}s! Menembakkan Jaring SHORT bertingkat...`, symbol);

    await this.deployGridLadder(symbol, alert.currentPrice);
  }

  /**
   * Membuat dan menembakkan Jaring Order SHORT bertingkat
   */
  private async deployGridLadder(symbol: string, currentPrice: number) {
    const gridCfg = this.config.grid;
    const exitCfg = this.config.exit;
    const leverage = this.config.leverage || 5;

    const layers: GridLayer[] = [];
    let currentMargin = gridCfg.marginPerLayerUsdt;
    let totalPlannedMargin = 0;

    // Layer 0: Langsung terisi di harga pasar saat spike (Market / Immediate entry)
    const layer0Qty = parseFloat(binanceFutures.formatQty(symbol, (currentMargin * leverage) / currentPrice));
    layers.push({
      layerIndex: 0,
      price: currentPrice,
      qty: layer0Qty,
      marginUsdt: currentMargin,
      status: 'FILLED',
      filledAt: Date.now(),
    });
    totalPlannedMargin += currentMargin;

    // Layer 1 hingga N: Diletakkan berjarak layerSpacingPct di atas harga pasar
    for (let i = 1; i < gridCfg.totalLayers; i++) {
      currentMargin *= gridCfg.martingaleMultiplier;
      if (totalPlannedMargin + currentMargin > gridCfg.maxTotalMarginPerCoin) {
        break;
      }

      const layerPrice = currentPrice * (1 + (i * gridCfg.layerSpacingPct) / 100);
      const layerQty = parseFloat(binanceFutures.formatQty(symbol, (currentMargin * leverage) / layerPrice));

      layers.push({
        layerIndex: i,
        price: parseFloat(binanceFutures.formatPrice(symbol, layerPrice)),
        qty: layerQty,
        marginUsdt: currentMargin,
        status: 'PENDING',
      });
      totalPlannedMargin += currentMargin;
    }

    const initialPos: ActivePosition = {
      id: `${symbol}_${Date.now()}`,
      symbol,
      side: 'SHORT',
      leverage,
      totalQty: layer0Qty,
      avgEntryPrice: currentPrice,
      currentPrice,
      unrealizedPnl: 0,
      pnlPct: 0,
      peakPnlPct: 0,
      totalMarginUsed: layers[0].marginUsdt,
      layers,
      openedAt: Date.now(),
      targetTpPrice: currentPrice * (1 - exitCfg.takeProfitPct / 100),
      hardSlPrice: currentPrice * (1 + exitCfg.hardStopLossPct / 100),
      status: 'SNIPING',
    };

    this.activePositions.set(symbol, initialPos);
    db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});

    if (this.config.tradingMode === 'LIVE') {
      // Live Trading: Kirim batch orders ke Binance Futures
      await binanceFutures.setLeverage(symbol, leverage);
      await binanceFutures.setMarginType(symbol, this.config.marginType || 'CROSSED');

      // 1. Eksekusi market order untuk layer 0
      const res0 = await binanceFutures.closePositionMarket(symbol, 'SELL', layer0Qty);
      if (res0?.orderId) {
        layers[0].orderId = String(res0.orderId);
      }

      // 2. Kirim limit orders untuk layer 1 ke atas via batchOrders
      const batchPayload = layers.slice(1).map((l) => ({
        symbol,
        side: 'SELL',
        type: 'LIMIT',
        quantity: binanceFutures.formatQty(symbol, l.qty),
        price: binanceFutures.formatPrice(symbol, l.price),
        timeInForce: 'GTC',
      }));

      if (batchPayload.length > 0) {
        const batchRes = await binanceFutures.sendBatchOrders(batchPayload);
        for (let i = 0; i < batchRes.length; i++) {
          if (batchRes[i]?.orderId) {
            layers[i + 1].orderId = String(batchRes[i].orderId);
          }
        }
      }
    }

    logger.log(
      'SUCCESS',
      `🎯 [JARING SHORT DITERBITKAN] ${symbol}: ${layers.length} Layer terpasang. Layer #0 terisi di $${currentPrice}. Target TP: $${initialPos.targetTpPrice.toFixed(4)} (-${exitCfg.takeProfitPct}%)`,
      symbol
    );
  }

  /**
   * Pembaruan live harga dari WebSocket untuk mengecek trigger jaring dan TP/SL
   */
  private onPriceTick(tickers: any[]) {
    if (!this.isRunning || this.activePositions.size === 0) return;

    for (const t of tickers) {
      const symbol = t.s;
      const pos = this.activePositions.get(symbol);
      if (!pos) continue;

      const currentPrice = parseFloat(t.c || t.p || '0');
      if (currentPrice <= 0) continue;

      pos.currentPrice = currentPrice;

      // 1. Cek apakah ada layer pending yang tertabrak harga atas (Layer Fill)
      let layersChanged = false;
      for (const layer of pos.layers) {
        if (layer.status === 'PENDING' && currentPrice >= layer.price) {
          layer.status = 'FILLED';
          layer.filledAt = Date.now();
          layersChanged = true;
          logger.log(
            'SNIPER',
            `🕸️ [LAYER TERISI] ${symbol} Layer #${layer.layerIndex} terisi @ $${layer.price} (Qty: ${layer.qty}, Margin: $${layer.marginUsdt.toFixed(2)})`,
            symbol
          );
        }
      }

      // 2. Jika ada layer baru yang terisi, hitung ulang Average Entry Price & Target TP
      if (layersChanged) {
        this.recalculatePositionAverage(pos);
        db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});
      }

      // 3. Hitung Floating PnL
      // Untuk posisi SHORT: PnL = (AvgEntry - CurrentPrice) * TotalQty
      const pnl = (pos.avgEntryPrice - currentPrice) * pos.totalQty;
      pos.unrealizedPnl = Math.round(pnl * 100) / 100;
      pos.pnlPct = Math.round(((pos.avgEntryPrice - currentPrice) / pos.avgEntryPrice) * pos.leverage * 1000) / 10;

      if (pos.pnlPct > pos.peakPnlPct) {
        pos.peakPnlPct = pos.pnlPct;
      }

      // 4. Evaluasi Kondisi Exit:
      // A. HARD STOP LOSS (Proteksi Runaway Pump)
      if (currentPrice >= pos.hardSlPrice) {
        this.closePosition(pos, 'HARD_STOP_LOSS', currentPrice);
        continue;
      }

      // B. TAKE PROFIT PULLBACK (DILENGKAPI STAGE 1 PARTIAL TP & BEP PROTECTION)
      if (currentPrice <= pos.targetTpPrice) {
        if (this.config.exit.partialTpEnabled && !pos.partialTpDone && pos.totalQty > 0) {
          const ratio = this.config.exit.partialTpRatio || 0.5;
          const partialQty = parseFloat(binanceFutures.formatQty(pos.symbol, pos.totalQty * ratio));
          if (partialQty > 0 && partialQty < pos.totalQty) {
            const partialPnl = Math.round((pos.avgEntryPrice - currentPrice) * partialQty * 100) / 100;
            if (this.config.tradingMode === 'LIVE') {
              binanceFutures.closePositionMarket(pos.symbol, 'BUY', partialQty).catch(() => {});
            } else {
              this.virtualBalance += partialPnl;
            }
            pos.totalQty = parseFloat(binanceFutures.formatQty(pos.symbol, pos.totalQty - partialQty));
            pos.partialTpDone = true;
            pos.partialRealizedPnl = (pos.partialRealizedPnl || 0) + partialPnl;
            // Geser Hard Stop Loss ke Break-Even (Avg Entry Price) -> Trade Bebas Risiko 100%!
            pos.hardSlPrice = pos.avgEntryPrice;
            // Target TP tahap 2 digeser lebih dalam (2.5% di bawah average entry)
            pos.targetTpPrice = pos.avgEntryPrice * (1 - (this.config.exit.takeProfitPct * 2) / 100);
            logger.log(
              'SUCCESS',
              `🎯 [STAGE 1 PARTIAL TP 50%] ${pos.symbol}: Cuan +$${partialPnl.toFixed(2)} berhasil diamankan! Stop-Loss digeser ke BEP ($${pos.avgEntryPrice.toFixed(4)}). Sisa ${pos.totalQty} koin memburu Stage 2 TP @ $${pos.targetTpPrice.toFixed(4)}.`,
              pos.symbol
            );
            this.broadcastStatus();
            db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});
            continue;
          }
        }

        this.closePosition(pos, 'TAKE_PROFIT', currentPrice);
        continue;
      }

      // C. TRAILING TAKE PROFIT
      if (this.config.exit.trailingTpEnabled && pos.peakPnlPct >= this.config.exit.takeProfitPct * pos.leverage) {
        const dropFromPeak = pos.peakPnlPct - pos.pnlPct;
        const callbackThreshold = (this.config.exit.trailingCallbackPct || 0.4) * pos.leverage;
        if (dropFromPeak >= callbackThreshold && pos.pnlPct > 0) {
          this.closePosition(pos, 'TRAILING_TP', currentPrice);
          continue;
        }
      }
    }
  }

  private recalculatePositionAverage(pos: ActivePosition) {
    const filledLayers = pos.layers.filter((l) => l.status === 'FILLED');
    let totalNotional = 0;
    let totalQty = 0;
    let totalMargin = 0;

    for (const l of filledLayers) {
      totalNotional += l.price * l.qty;
      totalQty += l.qty;
      totalMargin += l.marginUsdt;
    }

    if (totalQty > 0) {
      pos.totalQty = parseFloat(binanceFutures.formatQty(pos.symbol, totalQty));
      pos.avgEntryPrice = totalNotional / totalQty;
      pos.totalMarginUsed = totalMargin;

      const exitCfg = this.config.exit;
      pos.targetTpPrice = pos.avgEntryPrice * (1 - exitCfg.takeProfitPct / 100);
      pos.hardSlPrice = pos.avgEntryPrice * (1 + exitCfg.hardStopLossPct / 100);

      logger.log(
        'INFO',
        `📊 [RECALCULATE AVG] ${pos.symbol}: Entry Rata-rata baru: $${pos.avgEntryPrice.toFixed(4)} | Volume: ${pos.totalQty} | TP Baru: $${pos.targetTpPrice.toFixed(4)}`,
        pos.symbol
      );
    }
  }

  /**
   * Menutup posisi dan mencatat realized PnL
   */
  public async closePosition(
    pos: ActivePosition,
    reason: ClosedTrade['exitReason'],
    closePrice: number
  ) {
    pos.status = 'CLOSING';
    const durationSeconds = Math.round((Date.now() - pos.openedAt) / 1000);
    const pnl = (pos.avgEntryPrice - closePrice) * pos.totalQty;
    const finalRealizedPnl = Math.round((pnl + (pos.partialRealizedPnl || 0)) * 100) / 100;
    const pnlPct = Math.round(((pos.avgEntryPrice - closePrice) / pos.avgEntryPrice) * pos.leverage * 1000) / 10;

    if (this.config.tradingMode === 'LIVE') {
      // Live Trading: Batalkan order limit pending lalu tutup posisi market
      await binanceFutures.cancelAllOrders(pos.symbol);
      await binanceFutures.closePositionMarket(pos.symbol, 'BUY', pos.totalQty);
    } else {
      // Paper Trading: Sesuaikan saldo virtual untuk sisa posisi
      this.virtualBalance += Math.round(pnl * 100) / 100;
    }

    const trade: ClosedTrade = {
      id: Math.random().toString(36).substring(2, 9),
      symbol: pos.symbol,
      side: 'SHORT',
      entryPrice: parseFloat(binanceFutures.formatPrice(pos.symbol, pos.avgEntryPrice)),
      exitPrice: parseFloat(binanceFutures.formatPrice(pos.symbol, closePrice)),
      qty: pos.totalQty,
      marginUsed: pos.totalMarginUsed,
      realizedPnl: finalRealizedPnl,
      pnlPct,
      durationSeconds,
      exitReason: reason,
      isPaper: this.config.tradingMode === 'PAPER',
      closedAt: new Date().toLocaleTimeString('id-ID'),
      timestamp: Date.now(),
    };

    this.closedTrades.unshift(trade);
    if (this.closedTrades.length > 100) this.closedTrades.pop();

    this.activePositions.delete(pos.symbol);

    db.saveTrade(trade).catch(() => {});
    db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});

    // Berikan cooldown pada koin yang baru ditutup agar tidak re-enter pucuk yang sama
    this.scanner.setCooldown(pos.symbol, this.config.scanner.cooldownMinutes || 10);

    const isProfit = finalRealizedPnl >= 0;
    const reasonLabel =
      reason === 'TAKE_PROFIT'
        ? '🎯 Take Profit (Pullback Wick)'
        : reason === 'TRAILING_TP'
        ? '📈 Trailing Take Profit'
        : reason === 'HARD_STOP_LOSS'
        ? '🛑 Hard Stop Loss (Cut-Off)'
        : reason === 'TIME_LIMIT_EXIT'
        ? '⏰ Batas Waktu Hold'
        : 'Tutup Manual';

    logger.log(
      isProfit ? 'SUCCESS' : 'WARN',
      `🏁 [POSISI DITUTUP] ${pos.symbol} SHORT | Aksi: ${reasonLabel} | Entry: $${trade.entryPrice} ➜ Exit: $${trade.exitPrice} | PnL: ${finalRealizedPnl >= 0 ? '+' : ''}$${finalRealizedPnl} USDT (${pnlPct >= 0 ? '+' : ''}${pnlPct}%) | Durasi: ${durationSeconds} detik`,
      pos.symbol
    );

    this.broadcastStatus();
  }

  /**
   * Pengecekan batas waktu hold maksimal (Time-limit exit)
   */
  private checkTimeLimitsAndTrailing() {
    const maxHoldMs = (this.config.exit.maxHoldMinutes || 10) * 60 * 1000;
    const now = Date.now();

    for (const pos of this.activePositions.values()) {
      if (now - pos.openedAt >= maxHoldMs && pos.status === 'SNIPING') {
        logger.log('WARN', `⏰ [TIME LIMIT] ${pos.symbol} telah ditahan lebih dari ${this.config.exit.maxHoldMinutes} menit. Menutup posisi secara paksa...`, pos.symbol);
        this.closePosition(pos, 'TIME_LIMIT_EXIT', pos.currentPrice);
      }
    }
  }

  public getStatus(): EngineStatus {
    const totalTrades = this.closedTrades.length;
    const wins = this.closedTrades.filter((t) => t.realizedPnl >= 0).length;
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0;
    const accumulatedPnl = Math.round(this.closedTrades.reduce((acc, t) => acc + t.realizedPnl, 0) * 100) / 100;

    return {
      isRunning: this.isRunning,
      tradingMode: this.config.tradingMode,
      virtualBalance: Math.round(this.virtualBalance * 100) / 100,
      activePositionsCount: this.activePositions.size,
      spikesDetectedToday: this.spikesDetectedToday,
      totalTrades,
      winRate,
      accumulatedPnl,
      activePositions: Array.from(this.activePositions.values()),
      recentSpikes: this.scanner.getRecentSpikes(),
      recentTrades: this.closedTrades.slice(0, 20),
      cooldownCoins: this.scanner.getCooldowns(),
      monitoredCoinsCount: this.scanner.getTotalMonitoredSymbols(),
      ticksPerSecond: this.scanner.getTicksPerSecond(),
      leverage: this.config.leverage || 5,
      marginType: this.config.marginType || 'CROSSED',
    };
  }

  public onStatus(callback: (status: EngineStatus) => void) {
    this.statusListeners.push(callback);
  }

  public onConfig(callback: (config: BotConfig) => void) {
    this.configListeners.push(callback);
  }

  private broadcastStatus() {
    const status = this.getStatus();
    for (const fn of this.statusListeners) {
      fn(status);
    }
  }

  private broadcastConfig() {
    for (const fn of this.configListeners) {
      fn(this.config);
    }
  }

  /**
   * Otomatis membaca ulang konfigurasi dari Database PostgreSQL jika terjadi perubahan "dari belakang"
   */
  public async syncConfigFromDb(): Promise<boolean> {
    if (!db.isConnected) return false;
    try {
      const dbCfg = await db.loadConfig();
      if (!dbCfg) return false;
      const raw = JSON.stringify(dbCfg);
      if (raw !== this.lastSyncedConfigJson) {
        this.lastSyncedConfigJson = raw;
        this.config = { ...this.config, ...dbCfg };
        this.scanner.updateConfig(this.config.scanner);
        if (this.config.apiKey && this.config.apiSecret) {
          binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
        }
        logger.log('INFO', '🔄 [DATABASE AUTO-SYNC] Konfigurasi bot otomatis diperbarui dari PostgreSQL!');
        this.broadcastConfig();
        this.broadcastStatus();
        return true;
      }
    } catch (e: any) {
      // ignore
    }
    return false;
  }

  public resetDemoWallet() {
    this.virtualBalance = this.config.paperTrading?.initialVirtualBalance || 245;
    this.closedTrades = [];
    this.activePositions.clear();
    db.clearAllTrades().catch(() => {});
    db.saveState(this.virtualBalance, [], 0).catch(() => {});
    logger.log('INFO', '🧹 Saldo dan riwayat trade demo berhasil di-reset.');
    this.broadcastStatus();
  }
}
