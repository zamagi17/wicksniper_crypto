import fs from 'fs';
import path from 'path';
import { ActivePosition, BotConfig, ClosedTrade, EngineStatus, GridLayer, SpikeAlert } from '../types';
import { binanceFutures } from './binance';
import { SpikeScanner } from './scanner';
import { logger } from './logger';
import { db } from './db';
import { telegram } from './telegram';

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
  private realBalance: number = 0;
  private liveAvailableBalance: number = 0;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.virtualBalance = this.config.paperTrading?.initialVirtualBalance || 1000;
    this.scanner = new SpikeScanner(this.config.scanner);
    telegram.updateConfig(this.config.telegram);
    if (this.config.apiKey && this.config.apiSecret) {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
    }
    this.initListeners();
    if (this.config.tradingMode === 'LIVE') {
      setTimeout(() => {
        this.syncLiveBalance().then(() => this.broadcastStatus()).catch(() => {});
      }, 1500);
    }
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
        spikeMinPercent: 2.0,
        volumeSpikeMultiplier: 2.0,
        minPriceUsdt: 0.005,
        maxPriceUsdt: 2000,
        excludeSymbols: ['USDCUSDT', 'FDUSDUSDT', 'BTCUSDT', 'ETHUSDT'],
        cooldownMinutes: 20,
      },
      grid: {
        maxConcurrentCoins: 2,
        totalLayers: 25,
        layerSpacingPct: 1.2,
        marginPerLayerUsdt: 3.0,
        martingaleMultiplier: 1.1,
        maxTotalMarginPerCoin: 50.0,
      },
      exit: {
        takeProfitPct: 1.2,
        trailingTpEnabled: true,
        trailingCallbackPct: 0.4,
        hardStopLossPct: 4.5,
        maxHoldMinutes: 60,
        partialTpEnabled: false,
        partialTpRatio: 0.5,
      },
      paperTrading: {
        initialVirtualBalance: 245.0,
      },
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        notifyOnNewOrder: true,
        notifyOnLayerFill: true,
        notifyOnClose: true,
      },
      security: {
        password: 'admin123',
      },
      server: {
        port: 3005,
      },
    };
  }

  public async saveConfig(newConfig: Partial<BotConfig>): Promise<BotConfig> {
    const oldBalance = this.config.paperTrading?.initialVirtualBalance;
    this.config = {
      ...this.config,
      ...newConfig,
      exit: { ...this.config.exit, ...(newConfig.exit || {}) },
      scanner: { ...this.config.scanner, ...(newConfig.scanner || {}) },
      grid: { ...this.config.grid, ...(newConfig.grid || {}) },
      telegram: { ...this.config.telegram, ...(newConfig.telegram || {}) },
      security: { ...this.config.security, ...(newConfig.security || {}) },
    };
    this.scanner.updateConfig(this.config.scanner);
    if (this.config.telegram) {
      telegram.updateConfig(this.config.telegram);
    }
    if (this.config.apiKey && this.config.apiSecret) {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
    }
    if (
      newConfig.paperTrading?.initialVirtualBalance !== undefined &&
      newConfig.paperTrading.initialVirtualBalance !== oldBalance
    ) {
      this.virtualBalance = newConfig.paperTrading.initialVirtualBalance;
      await db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});
      logger.log('INFO', `💰 Saldo Paper Trading disesuaikan ke $${this.virtualBalance.toFixed(2)} USDT.`);
    }
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.log('INFO', '⚙️ Konfigurasi Wick Sniper berhasil diperbarui.');
    } catch (e: any) {
      logger.log('ERROR', `Gagal menyimpan konfigurasi: ${e.message}`);
    }
    this.lastSyncedConfigJson = JSON.stringify(this.config);
    await db.saveConfig(this.config).catch(() => {});
    if (this.config.tradingMode === 'LIVE') {
      this.syncLiveBalance().then(() => this.broadcastStatus()).catch(() => {});
    }
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
        this.config = {
          ...this.config,
          ...dbCfg,
          exit: { ...this.config.exit, ...(dbCfg.exit || {}) },
          scanner: { ...this.config.scanner, ...(dbCfg.scanner || {}) },
          grid: { ...this.config.grid, ...(dbCfg.grid || {}) },
          telegram: { ...this.config.telegram, ...(dbCfg.telegram || {}) },
          security: { ...this.config.security, ...(dbCfg.security || {}) },
        };
        this.scanner.updateConfig(this.config.scanner);
        if (this.config.telegram) {
          telegram.updateConfig(this.config.telegram);
        }
        this.lastSyncedConfigJson = JSON.stringify(dbCfg);
        if (this.config.apiKey && this.config.apiSecret) {
          binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
        }
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
      const dbSpikes = await db.loadRecentSpikes(50);
      if (dbSpikes.length > 0) {
        this.scanner.setRecentSpikes(dbSpikes);
        logger.log('INFO', `📡 [DATABASE] ${dbSpikes.length} riwayat spike dimuat dari PostgreSQL.`);
      }
    }

    logger.log('SUCCESS', `🚀 [WICK SNIPER ENGINE AKTIF] Mode: ${this.config.tradingMode} | Leverage: ${this.config.leverage}x`);
    logger.log('INFO', `🎯 Target Spike: >= +${this.config.scanner.spikeMinPercent}% dalam ${this.config.scanner.spikeLookbackSeconds}s | TP: ${this.config.exit.takeProfitPct}% | Hard SL: ${this.config.exit.hardStopLossPct}%`);

    await binanceFutures.syncTime();
    await binanceFutures.loadExchangeInfo();
    binanceFutures.startFastTickerStream();
    await binanceFutures.startTickerWebSocket();
    this.scanner.start();

    if (this.config.tradingMode === 'LIVE') {
      await this.syncLiveBalance();
    }

    // Heartbeat ticker, time-limit check tiap 1 detik, sync live position tiap 3s, & sinkronisasi DB tiap 5 detik
    let tickCount = 0;
    if (!this.tickInterval) {
      this.tickInterval = setInterval(async () => {
        this.checkTimeLimitsAndTrailing();
        this.broadcastStatus();
        tickCount++;
        if (tickCount % 3 === 0 && this.config.tradingMode === 'LIVE') {
          await this.syncLivePositions();
          await this.syncLiveBalance();
        }
        if (tickCount % 5 === 0) {
          await this.syncConfigFromDb();
        }
        // Jika bot dihentikan dan semua posisi sudah tertutup, bersihkan interval
        if (!this.isRunning && this.activePositions.size === 0 && this.tickInterval) {
          clearInterval(this.tickInterval);
          this.tickInterval = null;
        }
      }, 1000);
    }
  }

  public stop() {
    this.isRunning = false;
    logger.log('WARN', '🛑 Wick Sniper Engine dinonaktifkan (Tidak akan membuka trade baru).');
    if (this.activePositions.size > 0) {
      logger.log('INFO', `🛡️ Masih terdapat ${this.activePositions.size} posisi aktif. Bot tetap mengawal TP/SL hingga semua posisi selesai ditutup.`);
    } else {
      if (this.tickInterval) {
        clearInterval(this.tickInterval);
        this.tickInterval = null;
      }
    }
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
      db.saveSpike(alert).catch(() => {});
      return;
    }

    // Cek apakah koin ini sudah memiliki posisi aktif
    if (this.activePositions.has(symbol)) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Sudah ada posisi aktif pada ${symbol}`;
      db.saveSpike(alert).catch(() => {});
      return;
    }

    alert.status = 'EXECUTING';
    logger.log('SNIPER', `🚨 [SPONGE SPIKE DETECTED] ${symbol} melonjak +${alert.surgePct}% dalam ${alert.lookbackSeconds}s! Menembakkan Jaring SHORT bertingkat...`, symbol);
    db.saveSpike(alert).catch(() => {});

    await this.deployGridLadder(symbol, alert.currentPrice, alert.surgePct, alert.lookbackSeconds);
  }

  /**
   * Membuat dan menembakkan Jaring Order SHORT bertingkat
   */
  private async deployGridLadder(
    symbol: string,
    currentPrice: number,
    surgePct: number = 0,
    lookbackSeconds: number = 20
  ) {
    const gridCfg = this.config.grid;
    const exitCfg = this.config.exit;
    const leverage = this.config.leverage || 5;
    const prec = binanceFutures.getPrecision(symbol);

    const layers: GridLayer[] = [];
    let currentMargin = gridCfg.marginPerLayerUsdt;
    let totalPlannedMargin = 0;

    // Layer 0: Langsung terisi di harga pasar saat spike (Market / Immediate entry)
    let layer0Planned = (currentMargin * leverage) / currentPrice;
    if (layer0Planned * currentPrice < prec.minNotional) {
      layer0Planned = (prec.minNotional * 1.05) / currentPrice;
    }
    const layer0Qty = parseFloat(binanceFutures.formatQty(symbol, layer0Planned));
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
      let layerPlanned = (currentMargin * leverage) / layerPrice;
      if (layerPlanned * layerPrice < prec.minNotional) {
        layerPlanned = (prec.minNotional * 1.05) / layerPrice;
      }
      const layerQty = parseFloat(binanceFutures.formatQty(symbol, layerPlanned));

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

    if (this.config.tradingMode === 'LIVE') {
      // Live Trading: Kirim batch orders ke Binance Futures
      await binanceFutures.setLeverage(symbol, leverage);
      await binanceFutures.setMarginType(symbol, this.config.marginType || 'CROSSED');

      // 1. Eksekusi market order untuk layer 0 (Mendukung One-Way & Hedge Mode)
      const res0 = await binanceFutures.openMarketOrder(symbol, 'SELL', layer0Qty);
      if (!res0?.orderId) {
        logger.log(
          'ERROR',
          `❌ [ORDER GAGAL] Gagal membuka Layer 0 SHORT untuk ${symbol} di Binance! Membatalkan penempatan jaring. Cek saldo USDT atau izin Futures API Key.`,
          symbol
        );
        return;
      }
      layers[0].orderId = String(res0.orderId);

      // Sinkronisasi HARGA & KUANTITAS EKSEKUSI RIIL dari Binance matching engine
      let executedQty = parseFloat(res0.executedQty || '0');
      let cumQuote = parseFloat(res0.cumQuote || '0');
      let realEntryPrice = parseFloat(res0.avgPrice || '0');
      if ((!realEntryPrice || realEntryPrice <= 0) && executedQty > 0 && cumQuote > 0) {
        realEntryPrice = cumQuote / executedQty;
      }

      // Jika avgPrice masih 0 (karena Binance Futures API merespon status NEW seketika sebelum pembukuan fill selesai),
      // tunggu sejenak (120ms) lalu query posisi riil dari positionRisk atau userTrades
      if (!realEntryPrice || realEntryPrice <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          const realPos = await binanceFutures.getOpenPosition(symbol);
          if (realPos && Math.abs(realPos.positionAmt) > 0 && realPos.entryPrice > 0) {
            realEntryPrice = realPos.entryPrice;
            executedQty = Math.abs(realPos.positionAmt);
          } else {
            const recentTrades = await binanceFutures.getUserTrades(symbol, 3);
            const entryTrade = recentTrades.find(
              (t: any) => t.side === 'SELL' && (!res0.orderId || String(t.orderId) === String(res0.orderId))
            );
            if (entryTrade && parseFloat(entryTrade.price) > 0) {
              realEntryPrice = parseFloat(entryTrade.price);
              executedQty = parseFloat(entryTrade.qty || '0');
            }
          }
        } catch (e: any) {
          console.warn(`[Sync Entry] Gagal mengambil posisi riil Binance: ${e.message}`);
        }
      }

      if (realEntryPrice > 0) {
        layers[0].price = realEntryPrice;
        initialPos.avgEntryPrice = realEntryPrice;
        if (executedQty > 0) {
          layers[0].qty = executedQty;
          initialPos.totalQty = executedQty;
          layers[0].marginUsdt = (executedQty * realEntryPrice) / leverage;
          initialPos.totalMarginUsed = layers[0].marginUsdt;
        }

        // Sinkronkan ulang harga Limit Order layer 1 ke atas dengan jangkar harga eksekusi riil (realEntryPrice)
        let runningMargin = gridCfg.marginPerLayerUsdt;
        for (let i = 1; i < layers.length; i++) {
          runningMargin *= gridCfg.martingaleMultiplier;
          const layerPrice = realEntryPrice * (1 + (i * gridCfg.layerSpacingPct) / 100);
          let layerPlanned = (runningMargin * leverage) / layerPrice;
          if (layerPlanned * layerPrice < prec.minNotional) {
            layerPlanned = (prec.minNotional * 1.05) / layerPrice;
          }
          layers[i].price = parseFloat(binanceFutures.formatPrice(symbol, layerPrice));
          layers[i].qty = parseFloat(binanceFutures.formatQty(symbol, layerPlanned));
        }

        // Hitung ulang target TP dan SL berdasarkan harga eksekusi riil Binance
        initialPos.targetTpPrice = realEntryPrice * (1 - exitCfg.takeProfitPct / 100);
        initialPos.hardSlPrice = realEntryPrice * (1 + exitCfg.hardStopLossPct / 100);
        logger.log(
          'INFO',
          `🎯 [LIVE FILL SYNC] ${symbol} Layer #0 terisi riil di Binance @ $${realEntryPrice.toFixed(6)} | Grid Jaring & Target TP disinkronkan ke $${initialPos.targetTpPrice.toFixed(6)}`,
          symbol
        );
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

    this.activePositions.set(symbol, initialPos);
    if (this.config.tradingMode === 'LIVE') {
      this.syncLiveTakeProfitOrder(initialPos).catch(() => {});
    }
    db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});

    telegram.notifyNewOrder(
      initialPos,
      this.config.tradingMode,
      surgePct,
      lookbackSeconds,
      gridCfg.layerSpacingPct,
      exitCfg.takeProfitPct,
      exitCfg.hardStopLossPct
    );

    logger.log(
      'SUCCESS',
      `🎯 [JARING SHORT DITERBITKAN] ${symbol}: ${layers.length} Layer terpasang. Layer #0 terisi di $${currentPrice}. Target TP: $${initialPos.targetTpPrice.toFixed(4)} (-${exitCfg.takeProfitPct}%)`,
      symbol
    );
  }

  /**
   * Pembaruan live harga dari WebSocket untuk mengecek trigger jaring dan TP/SL
   */
  private async onPriceTick(tickers: any[]) {
    if (this.activePositions.size === 0) return;

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
          telegram.notifyLayerFill(
            pos,
            layer,
            pos.layers.filter((l) => l.status === 'FILLED').length,
            pos.layers.length
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
      // Proteksi anti-whipsaw / order propagation: beri waktu minimal 3 detik sejak order dibuka
      // dan pastikan harga pasar benar-benar di bawah avgEntryPrice (profit riil)
      const tradeAgeMs = Date.now() - pos.openedAt;
      if (currentPrice <= pos.targetTpPrice && currentPrice < pos.avgEntryPrice && tradeAgeMs >= 3000) {
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
            telegram.notifyPartialTp(
              pos.symbol,
              partialPnl,
              pos.totalQty,
              pos.avgEntryPrice,
              pos.targetTpPrice
            );
            this.broadcastStatus();
            db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});
            continue;
          }
        }

        // Jika dalam mode LIVE dan memiliki Limit TP order yang terpasang di Binance:
        if (this.config.tradingMode === 'LIVE' && pos.tpOrderId) {
          // Periksa apakah posisi di Binance sudah tertutup otomatis oleh Limit TP matching engine
          const openPos = await binanceFutures.getOpenPosition(pos.symbol);
          if (!openPos || Math.abs(openPos.positionAmt) === 0) {
            // Sudah terisi 100% oleh Limit Order Binance di targetTpPrice tanpa slippage!
            this.closePosition(pos, 'TAKE_PROFIT', pos.targetTpPrice);
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

      // Jika dalam mode LIVE, sinkronkan Take Profit Limit Order ke Binance
      if (this.config.tradingMode === 'LIVE') {
        this.syncLiveTakeProfitOrder(pos).catch(() => {});
      }
    }
  }

  /**
   * Memasang atau memperbarui Order LIMIT BUY (Take Profit) langsung di buku pesanan Binance
   * Nol slippage & mendapatkan fee Maker (0.02%) yang jauh lebih hemat daripada market order
   */
  public async syncLiveTakeProfitOrder(pos: ActivePosition) {
    if (this.config.tradingMode !== 'LIVE' || !pos.targetTpPrice || pos.totalQty <= 0) return;
    try {
      // 1. Batalkan order TP lama jika ada
      if (pos.tpOrderId) {
        await binanceFutures.cancelOrder(pos.symbol, pos.tpOrderId).catch(() => {});
        pos.tpOrderId = undefined;
      }

      // Pastikan target TP berada di bawah harga pasar saat ini dan di bawah harga entri rata-rata (untuk posisi SHORT)
      const curPrice = pos.currentPrice || pos.avgEntryPrice;
      if (pos.targetTpPrice >= curPrice) {
        logger.log(
          'WARN',
          `⚠️ [LIMIT TP DITUNDA] ${pos.symbol}: Target TP ($${pos.targetTpPrice.toFixed(6)}) >= Harga Pasar ($${curPrice.toFixed(6)}). Menunda order limit untuk mencegah eksekusi seketika (marketable order).`,
          pos.symbol
        );
        return;
      }

      // 2. Pasang LIMIT BUY untuk Take Profit (reduceOnly)
      const tpRes = await binanceFutures.placeLimitOrder(
        pos.symbol,
        'BUY',
        pos.totalQty,
        pos.targetTpPrice,
        true
      );

      if (tpRes?.orderId) {
        pos.tpOrderId = String(tpRes.orderId);
        logger.log(
          'SUCCESS',
          `🎯 [LIMIT TP AKTIF] ${pos.symbol}: Order Limit Take Profit terpasang di Binance @ $${pos.targetTpPrice.toFixed(6)} (Qty: ${pos.totalQty}, Order ID: #${pos.tpOrderId})`,
          pos.symbol
        );
      }
    } catch (err: any) {
      console.error(`Gagal syncLiveTakeProfitOrder untuk ${pos.symbol}:`, err.message);
    }
  }

  /**
   * Menutup posisi secara manual di harga pasar saat ini atas instruksi pengguna
   */
  public async manualClosePosition(symbol: string): Promise<boolean> {
    const pos = this.activePositions.get(symbol);
    if (!pos) return false;
    logger.log('WARN', `⚡ [TUTUP POSISI MANUAL] Menutup posisi ${symbol} atas instruksi pengguna.`);
    await this.closePosition(pos, 'MANUAL_CLOSE', pos.currentPrice || pos.avgEntryPrice);
    this.broadcastStatus();
    return true;
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

    let actualExitPrice = closePrice;
    let actualRealizedPnl = finalRealizedPnl;
    let actualPnlPct = pnlPct;

    if (this.config.tradingMode === 'LIVE') {
      // Live Trading: Batalkan order limit pending lalu tutup posisi market
      await binanceFutures.cancelAllOrders(pos.symbol);

      // Ambil ukuran posisi riil langsung dari Binance matching engine agar kuantitas 100% presisi dan tidak kena reject -2022
      const realPos = await binanceFutures.getOpenPosition(pos.symbol);
      const closeQty = realPos && Math.abs(realPos.positionAmt) > 0 ? Math.abs(realPos.positionAmt) : pos.totalQty;

      let fillExitPrice = 0;
      let execQty = 0;

      if (closeQty > 0) {
        const closeRes = await binanceFutures.closePositionMarket(pos.symbol, 'BUY', closeQty);
        execQty = parseFloat(closeRes?.executedQty || '0');
        const cumQuote = parseFloat(closeRes?.cumQuote || '0');
        fillExitPrice = parseFloat(closeRes?.avgPrice || '0');
        if ((!fillExitPrice || fillExitPrice <= 0) && execQty > 0 && cumQuote > 0) {
          fillExitPrice = cumQuote / execQty;
        }

        if (fillExitPrice > 0) {
          actualExitPrice = fillExitPrice;
        }
      }

      // Tunggu sejenak agar matching engine Binance selesai membukukan userTrades
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Ambil riwayat trade terakhir dari Binance untuk sinkronisasi Realized PnL, Entry Price, Exit Price & Fee 100% presisi
      try {
        const recentTrades = await binanceFutures.getUserTrades(pos.symbol, 10);
        if (recentTrades.length > 0) {
          const minTime = pos.openedAt - 15000;
          // Trade BUY (penutupan short)
          let closingTrades = recentTrades.filter(
            (tr: any) => tr.side === 'BUY' && (!tr.time || tr.time >= minTime)
          );
          if (closingTrades.length === 0) {
            const latestBuy = recentTrades.find((tr: any) => tr.side === 'BUY');
            if (latestBuy) closingTrades = [latestBuy];
          }

          // Trade SELL (pembukaan short / layer terisi) untuk sinkronkan entry price aktual
          const openingTrades = recentTrades.filter(
            (tr: any) => tr.side === 'SELL' && (!tr.time || tr.time >= minTime)
          );
          if (openingTrades.length > 0) {
            let totalEntryQty = 0;
            let totalEntryQuote = 0;
            for (const otr of openingTrades) {
              const q = parseFloat(otr.qty || '0');
              const p = parseFloat(otr.price || '0');
              totalEntryQty += q;
              totalEntryQuote += q * p;
            }
            if (totalEntryQty > 0) {
              pos.avgEntryPrice = totalEntryQuote / totalEntryQty;
            }
          }

          if (closingTrades.length > 0) {
            let binancePnlSum = 0;
            let binanceFeeSum = 0;
            let totalTradedQty = 0;
            let totalTradedQuote = 0;

            for (const tr of closingTrades) {
              binancePnlSum += parseFloat(tr.realizedPnl || '0');
              binanceFeeSum += parseFloat(tr.commission || '0');
              const tQty = parseFloat(tr.qty || '0');
              const tPrice = parseFloat(tr.price || '0');
              totalTradedQty += tQty;
              totalTradedQuote += tQty * tPrice;
            }

            // Tambahkan fee pembukaan (SELL) jika ada
            for (const otr of openingTrades) {
              binanceFeeSum += parseFloat(otr.commission || '0');
            }

            if (totalTradedQty > 0) {
              actualExitPrice = totalTradedQuote / totalTradedQty;
            }

            // Realized PnL bersih (dikurangi total biaya transaksi roundtrip)
            const netBinancePnl = binancePnlSum - binanceFeeSum;
            actualRealizedPnl = Math.round(netBinancePnl * 100) / 100;
            const marginBase = pos.totalMarginUsed > 0 ? pos.totalMarginUsed : 1;
            actualPnlPct = Math.round((actualRealizedPnl / marginBase) * 1000) / 10;

            logger.log(
              actualRealizedPnl >= 0 ? 'SUCCESS' : 'WARN',
              `📊 [BINANCE PNL SYNC] ${pos.symbol}: Entry Riil: $${pos.avgEntryPrice.toFixed(6)} | Exit Riil: $${actualExitPrice.toFixed(6)} | Gross: $${binancePnlSum.toFixed(4)} | Fee: $${binanceFeeSum.toFixed(4)} | Net PnL: ${actualRealizedPnl >= 0 ? '+' : ''}$${actualRealizedPnl.toFixed(2)} USDT`,
              pos.symbol
            );
          } else if (fillExitPrice > 0) {
            const grossPnl = (pos.avgEntryPrice - fillExitPrice) * (execQty > 0 ? execQty : pos.totalQty);
            const estFee = (pos.avgEntryPrice + fillExitPrice) * (execQty > 0 ? execQty : pos.totalQty) * 0.0005;
            actualRealizedPnl = Math.round((grossPnl - estFee) * 100) / 100;
            const marginBase = pos.totalMarginUsed > 0 ? pos.totalMarginUsed : 1;
            actualPnlPct = Math.round((actualRealizedPnl / marginBase) * 1000) / 10;
          }
        }
      } catch (e: any) {
        console.warn(`[Sync PnL] Menggunakan kalkulasi lokal: ${e.message}`);
      }
    } else {
      // Paper Trading: Sesuaikan saldo virtual untuk sisa posisi
      this.virtualBalance += Math.round(pnl * 100) / 100;
    }

    const filledLayersCount = (pos.layers || []).filter((l) => l.status === 'FILLED').length;
    const totalLayersCount = (pos.layers || []).length;

    const trade: ClosedTrade = {
      id: Math.random().toString(36).substring(2, 9),
      symbol: pos.symbol,
      side: 'SHORT',
      entryPrice: parseFloat(binanceFutures.formatPrice(pos.symbol, pos.avgEntryPrice)),
      exitPrice: parseFloat(binanceFutures.formatPrice(pos.symbol, actualExitPrice)),
      qty: pos.totalQty,
      marginUsed: pos.totalMarginUsed,
      realizedPnl: actualRealizedPnl,
      pnlPct: actualPnlPct,
      durationSeconds,
      exitReason: reason,
      isPaper: this.config.tradingMode === 'PAPER',
      closedAt: new Date().toLocaleTimeString('id-ID'),
      timestamp: Date.now(),
      layersFilled: `${filledLayersCount}/${totalLayersCount}`,
      layersDetail: (pos.layers || []).map((l) => ({
        layerIndex: l.layerIndex,
        price: l.price,
        qty: l.qty,
        marginUsdt: l.marginUsdt,
        status: l.status,
      })),
      paramsSnapshot: {
        marginPerLayerUsdt: this.config.grid.marginPerLayerUsdt,
        totalLayers: this.config.grid.totalLayers,
        layerSpacingPct: this.config.grid.layerSpacingPct,
        martingaleMultiplier: this.config.grid.martingaleMultiplier,
        maxTotalMarginPerCoin: this.config.grid.maxTotalMarginPerCoin,
        takeProfitPct: this.config.exit.takeProfitPct,
        hardStopLossPct: this.config.exit.hardStopLossPct,
        maxHoldMinutes: this.config.exit.maxHoldMinutes,
        spikeMinPercent: this.config.scanner.spikeMinPercent,
        leverage: this.config.leverage,
        marginType: this.config.marginType,
      },
    };

    this.closedTrades.unshift(trade);
    if (this.closedTrades.length > 100) this.closedTrades.pop();

    this.activePositions.delete(pos.symbol);

    db.saveTrade(trade).catch(() => {});
    db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});

    telegram.notifyTradeClosed(
      trade,
      this.config.tradingMode === 'PAPER' ? this.virtualBalance : undefined
    );

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

  /**
   * Rekonsiliasi berkala posisi live dengan Binance matching engine
   */
  private async syncLivePositions() {
    if (this.config.tradingMode !== 'LIVE' || this.activePositions.size === 0) return;

    for (const [symbol, pos] of this.activePositions.entries()) {
      try {
        const realPos = await binanceFutures.getOpenPosition(symbol);
        if (!realPos) continue;

        // Jika di Binance posisinya sudah 0 dan posisi bot sudah berjalan lebih dari 5 detik,
        // artinya posisi sudah tertutup otomatis di Binance (Limit Take Profit terisi oleh matching engine)
        if (realPos.positionAmt === 0 && Date.now() - pos.openedAt > 5000 && pos.status === 'SNIPING') {
          logger.log('SUCCESS', `🎯 [REKONSILIASI LIVE] Limit Order TP ${symbol} telah dieksekusi oleh Binance! Menandai profit di bot...`, symbol);
          await this.closePosition(pos, 'TAKE_PROFIT', pos.targetTpPrice || pos.currentPrice);
          continue;
        }

        // Sinkronisasi kuantitas & avg entry price jika ada layer tambahan yang terisi di Binance
        const liveQty = Math.abs(realPos.positionAmt);
        if (liveQty > 0 && (Math.abs(pos.totalQty - liveQty) > 1e-6 || Math.abs(pos.avgEntryPrice - realPos.entryPrice) > 1e-6)) {
          pos.totalQty = liveQty;
          if (realPos.entryPrice > 0) {
            pos.avgEntryPrice = realPos.entryPrice;
            const exitCfg = this.config.exit;
            pos.targetTpPrice = pos.avgEntryPrice * (1 - exitCfg.takeProfitPct / 100);
            pos.hardSlPrice = pos.avgEntryPrice * (1 + exitCfg.hardStopLossPct / 100);
          }
        }
      } catch {}
    }
  }

  public getHistoricalTrades(limit: number = 50): ClosedTrade[] {
    return this.closedTrades.slice(0, limit);
  }

  public verifyPassword(password: string): boolean {
    const configured = this.config.security?.password || 'admin123';
    return String(password).trim() === configured;
  }

  public async changePassword(newPassword: string): Promise<boolean> {
    const cleaned = String(newPassword || '').trim();
    if (cleaned.length < 4) {
      throw new Error('Password baru minimal 4 karakter');
    }
    await this.saveConfig({
      security: {
        password: cleaned,
      },
    });
    logger.log('SUCCESS', '🔐 Password dashboard berhasil diperbarui.');
    return true;
  }

  private lastLoggedBalanceError: string = '';

  public async syncLiveBalance() {
    if (this.config.tradingMode !== 'LIVE') {
      return;
    }
    if (!this.config.apiKey || !this.config.apiSecret) {
      if (this.lastLoggedBalanceError !== 'NO_KEYS') {
        logger.log('WARN', '⚠️ [SINKRONISASI SALDO] API Key & Secret Binance belum diisi di Pengaturan.');
        this.lastLoggedBalanceError = 'NO_KEYS';
      }
      return;
    }
    try {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
      const balances = await binanceFutures.getFuturesAccountBalance();
      if (balances.length > 0) {
        const usdt = balances.find((b) => b.asset === 'USDT') || balances.find((b) => b.asset === 'USDC');
        if (usdt) {
          const wasZero = this.realBalance === 0;
          this.realBalance = usdt.balance;
          this.liveAvailableBalance = usdt.availableBalance;
          this.broadcastStatus();
          this.lastLoggedBalanceError = '';
          if (wasZero && this.realBalance >= 0) {
            logger.log('SUCCESS', `💰 [SALDO BINANCE LIVE TERHUBUNG] Total Saldo: $${this.realBalance.toFixed(2)} USDT | Tersedia: $${this.liveAvailableBalance.toFixed(2)} USDT`);
          }
        }
      } else if (binanceFutures.lastBalanceError) {
        if (this.lastLoggedBalanceError !== binanceFutures.lastBalanceError) {
          logger.log('WARN', `⚠️ [SINKRONISASI SALDO GAGAL] Binance: ${binanceFutures.lastBalanceError}`);
          this.lastLoggedBalanceError = binanceFutures.lastBalanceError;
        }
      }
    } catch (e: any) {
      console.error('Gagal mengambil saldo riil Binance:', e.message);
    }
  }

  public getStatus(): EngineStatus {
    const totalTrades = this.closedTrades.length;
    const wins = this.closedTrades.filter((t) => t.realizedPnl >= 0).length;
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0;
    const accumulatedPnl = Math.round(this.closedTrades.reduce((acc, t) => acc + t.realizedPnl, 0) * 100) / 100;

    if (this.config.tradingMode === 'LIVE' && this.realBalance === 0 && this.config.apiKey && this.config.apiSecret) {
      this.syncLiveBalance().then(() => this.broadcastStatus()).catch(() => {});
    }

    return {
      isRunning: this.isRunning,
      tradingMode: this.config.tradingMode,
      virtualBalance: Math.round(this.virtualBalance * 100) / 100,
      realBalance: this.config.tradingMode === 'LIVE' ? Math.round(this.realBalance * 100) / 100 : undefined,
      liveAvailableBalance: this.config.tradingMode === 'LIVE' ? Math.round(this.liveAvailableBalance * 100) / 100 : undefined,
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
        const oldBalance = this.config.paperTrading?.initialVirtualBalance;
        this.lastSyncedConfigJson = raw;
        this.config = {
          ...this.config,
          ...dbCfg,
          exit: { ...this.config.exit, ...(dbCfg.exit || {}) },
          scanner: { ...this.config.scanner, ...(dbCfg.scanner || {}) },
          grid: { ...this.config.grid, ...(dbCfg.grid || {}) },
          telegram: { ...this.config.telegram, ...(dbCfg.telegram || {}) },
          security: { ...this.config.security, ...(dbCfg.security || {}) },
        };
        this.scanner.updateConfig(this.config.scanner);
        if (this.config.telegram) {
          telegram.updateConfig(this.config.telegram);
        }
        if (this.config.apiKey && this.config.apiSecret) {
          binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
        }
        if (this.config.tradingMode === 'LIVE') {
          this.syncLiveBalance().catch(() => {});
        }
        if (
          this.config.paperTrading?.initialVirtualBalance !== undefined &&
          this.config.paperTrading.initialVirtualBalance !== oldBalance
        ) {
          this.virtualBalance = this.config.paperTrading.initialVirtualBalance;
          db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});
          logger.log('INFO', `💰 Saldo Paper Trading disesuaikan ke $${this.virtualBalance.toFixed(2)} USDT.`);
        }
        logger.log('INFO', '🔄 [DATABASE AUTO-SYNC] Konfigurasi bot otomatis diperbarui dari PostgreSQL!');
        this.broadcastConfig();
        this.broadcastStatus();
        return true;
      }

      // Cek apakah ada perubahan saldo manual di tabel wicksniper_state (hanya jika tidak ada posisi floating)
      if (this.activePositions.size === 0) {
        const dbState = await db.loadState();
        if (dbState && typeof dbState.virtualBalance === 'number') {
          if (Math.abs(dbState.virtualBalance - this.virtualBalance) > 0.01) {
            this.virtualBalance = dbState.virtualBalance;
            this.broadcastStatus();
          }
        }
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
