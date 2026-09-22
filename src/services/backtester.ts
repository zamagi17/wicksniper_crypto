import { dataFetcher, Candle } from './dataFetcher';

export interface BacktestParams {
  symbols: string[];
  startTime: number;
  endTime: number;
  leverage?: number;
  spikeMinPercent?: number;
  takeProfitPct?: number;
  hardStopLossPct?: number;
  trailingSlEnabled?: boolean;
  marginPerLayerUsdt?: number;
  totalLayers?: number;
  layerSpacingPct?: number;
  martingaleMultiplier?: number;
  maxTotalMarginPerCoin?: number;
  cooldownMinutes?: number;
  maxHoldMinutes?: number;
  partialTpEnabled?: boolean;
  partialTpRatio?: number;
  initialBalance?: number;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  entryTime: string;
  exitTime: string;
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  marginUsed: number;
  realizedPnl: number;
  pnlPct: number;
  exitReason: 'TAKE_PROFIT' | 'TRAILING_TP' | 'HARD_STOP_LOSS' | 'FEE_LOSS_EXIT' | 'TIME_LIMIT_EXIT' | 'MANUAL_CLOSE';
  durationMinutes: number;
  layersFilled: number;
  partialTpTaken: boolean;
}

export interface BacktestResult {
  symbols: string[];
  startDate: string;
  endDate: string;
  totalCandlesAnalyzed: number;
  initialBalance: number;
  finalBalance: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netProfitUsdt: number;
  netProfitPct: number;
  maxDrawdownUsdt: number;
  maxDrawdownPct: number;
  profitFactor: number;
  avgTradeDurationMinutes: number;
  partialTpTrades: number;
  trades: BacktestTrade[];
  equityCurve: { time: string; balance: number }[];
}

export class WickSniperBacktester {
  private calculateTrailingSLPrice(
    avgPrice: number,
    leverage: number,
    takeProfitPct: number,
    filledLayerCount: number,
    maxReturnRatio: number,
    tiers: Array<{ filledLayerMin: number; percentOfBase: number }>
  ): number {
    // Leverage-aware base SL calculation
    const tpNominal = takeProfitPct / 100;
    const tpReturn = tpNominal * leverage;
    const maxSLReturn = tpReturn * maxReturnRatio;
    const baseSLNominal = maxSLReturn / leverage;

    // Find tier based on filled layers
    let tierPercent = 1.0;
    for (let i = tiers.length - 1; i >= 0; i--) {
      const tier = tiers[i];
      if (filledLayerCount >= tier.filledLayerMin) {
        tierPercent = tier.percentOfBase;
        break;
      }
    }

    const newSlPercent = baseSLNominal * tierPercent;
    return avgPrice * (1 + newSlPercent);
  }

  public async run(params: BacktestParams): Promise<BacktestResult> {
    const leverage = params.leverage || 5;
    const spikeMinPercent = params.spikeMinPercent || 3.2;
    const takeProfitPct = params.takeProfitPct || 1.2;
    const hardStopLossPct = params.hardStopLossPct || 4.5;
    const trailingSlEnabled = params.trailingSlEnabled === true;
    const trailingSlMaxReturnRatio = 2.5;
    const trailingSlTiers = [
      { filledLayerMin: 5, percentOfBase: 0.3 },
      { filledLayerMin: 3, percentOfBase: 0.6 },
      { filledLayerMin: 1, percentOfBase: 0.8 },
      { filledLayerMin: 0, percentOfBase: 1.0 },
    ];
    const marginPerLayerUsdt = params.marginPerLayerUsdt || 5;
    const totalLayers = params.totalLayers || 6;
    const layerSpacingPct = params.layerSpacingPct || 1.0;
    const martingaleMultiplier = params.martingaleMultiplier || 1.15;
    const maxTotalMarginPerCoin = params.maxTotalMarginPerCoin || 35;
    const cooldownMinutes = params.cooldownMinutes || 10;
    const maxHoldMinutes = params.maxHoldMinutes || 10;
    const partialTpEnabled = params.partialTpEnabled === true;
    const partialTpRatio = params.partialTpRatio !== undefined ? params.partialTpRatio : 0.5;
    const initialBalance = params.initialBalance || 1000;

    let balance = initialBalance;
    let peakBalance = initialBalance;
    let maxDrawdownUsdt = 0;
    let maxDrawdownPct = 0;

    const allTrades: BacktestTrade[] = [];
    let totalCandlesAnalyzed = 0;
    const equityCurve: { time: string; balance: number }[] = [
      { time: new Date(params.startTime).toLocaleDateString('id-ID'), balance: initialBalance },
    ];

    for (const symbol of params.symbols) {
      const candles = await dataFetcher.getKlines(symbol, '1m', params.startTime, params.endTime);
      totalCandlesAnalyzed += candles.length;

      if (candles.length < 5) continue;

      let cooldownUntil = 0;

      for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        if (c.openTime < cooldownUntil) continue;

        // Pemicu Spike: Lonjakan cepat dari Open ke High atau dari prevClose ke High
        const prevC = candles[i - 1];
        const surgeFromOpen = ((c.high - c.open) / c.open) * 100;
        const surgeFromPrevClose = ((c.high - prevC.close) / prevC.close) * 100;
        const surge = Math.max(surgeFromOpen, surgeFromPrevClose);

        if (surge < spikeMinPercent) continue;

        // --- SIMULASI PENEMBAKAN JARING WICK SNIPER ---
        const entryTime = c.openTime;
        // Layer 0 terisi di sekitar 70% dari tinggi lonjakan candle
        const layer0Price = c.open + (c.high - c.open) * 0.7;

        interface SimLayer {
          layerIndex: number;
          price: number;
          qty: number;
          marginUsdt: number;
          status: 'FILLED' | 'PENDING' | 'CANCELLED';
        }

        const layers: SimLayer[] = [];
        let currentLayerMargin = marginPerLayerUsdt;
        let totalMargin = 0;

        // Layer 0: Terisi instan
        const layer0Qty = (currentLayerMargin * leverage) / layer0Price;
        layers.push({
          layerIndex: 0,
          price: layer0Price,
          qty: layer0Qty,
          marginUsdt: currentLayerMargin,
          status: 'FILLED',
        });
        totalMargin += currentLayerMargin;

        // Layer 1..N
        for (let l = 1; l < totalLayers; l++) {
          currentLayerMargin *= martingaleMultiplier;
          if (totalMargin + currentLayerMargin > maxTotalMarginPerCoin) break;

          const layerPrice = layer0Price * (1 + (l * layerSpacingPct) / 100);
          const layerQty = (currentLayerMargin * leverage) / layerPrice;
          layers.push({
            layerIndex: l,
            price: layerPrice,
            qty: layerQty,
            marginUsdt: currentLayerMargin,
            status: 'PENDING',
          });
          totalMargin += currentLayerMargin;
        }

        // Cek layer mana saja yang tertabrak oleh High candle saat ini
        for (const l of layers) {
          if (l.status === 'PENDING' && c.high >= l.price) {
            l.status = 'FILLED';
          }
        }

        // Hitung Average Entry Price & Batas TP / SL
        const calcAvg = () => {
          const filled = layers.filter((l) => l.status === 'FILLED');
          let notional = 0;
          let qty = 0;
          let margin = 0;
          for (const f of filled) {
            notional += f.price * f.qty;
            qty += f.qty;
            margin += f.marginUsdt;
          }
          const avgPrice = notional / qty;
          return { avgPrice, qty, margin };
        };

        let { avgPrice, qty, margin: usedMargin } = calcAvg();
        let targetTpPrice = avgPrice * (1 - takeProfitPct / 100);
        
        // Apply initial Trailing SL if enabled
        let hardSlPrice = avgPrice * (1 + hardStopLossPct / 100);
        if (trailingSlEnabled) {
          const filledCount = layers.filter(l => l.status === 'FILLED').length;
          hardSlPrice = this.calculateTrailingSLPrice(
            avgPrice,
            leverage,
            takeProfitPct,
            filledCount,
            trailingSlMaxReturnRatio,
            trailingSlTiers
          );
        }

        let tradeClosed = false;
        let exitPrice = 0;
        let exitReason: BacktestTrade['exitReason'] = 'TAKE_PROFIT';
        let exitTime = c.openTime;
        let partialDone = false;
        let partialRealizedPnl = 0;

        // Periksa pergerakan lilin-lilin berikutnya (hingga maxHoldMinutes)
        const maxIndex = Math.min(candles.length - 1, i + maxHoldMinutes);

        for (let k = i; k <= maxIndex; k++) {
          const evalCandle = candles[k];

          // 1. Cek apakah ada layer pending yang tertabrak harga atas (Layer Fill)
          let newLayersFilled = false;
          if (!partialDone) {
            for (const l of layers) {
              if (l.status === 'PENDING' && evalCandle.high >= l.price) {
                l.status = 'FILLED';
                newLayersFilled = true;
              }
            }
          }
          if (newLayersFilled) {
            const re = calcAvg();
            avgPrice = re.avgPrice;
            qty = re.qty;
            usedMargin = re.margin;
            targetTpPrice = avgPrice * (1 - takeProfitPct / 100);
            
            // Apply Trailing SL if enabled
            if (trailingSlEnabled) {
              const filledCount = layers.filter(l => l.status === 'FILLED').length;
              const newSlPrice = this.calculateTrailingSLPrice(
                avgPrice,
                leverage,
                takeProfitPct,
                filledCount,
                trailingSlMaxReturnRatio,
                trailingSlTiers
              );
              // Only tighten (lower), never relax (raise)
              if (newSlPrice < hardSlPrice) {
                hardSlPrice = newSlPrice;
              }
            } else {
              hardSlPrice = avgPrice * (1 + hardStopLossPct / 100);
            }
          }

          // 2. Evaluasi HARD STOP LOSS atau BEP EXIT
          if (evalCandle.high >= hardSlPrice) {
            tradeClosed = true;
            exitPrice = hardSlPrice;
            exitReason = partialDone ? 'TRAILING_TP' : 'HARD_STOP_LOSS';
            exitTime = evalCandle.openTime;
            break;
          }

          // 3. Evaluasi TAKE PROFIT (Ekor Jarum / Pullback Wick)
          // REALISTIC SEQUENCE MODEL (Anti-Lookahead Bias):
          // Pada lilin ke-i (lilin saat lonjakan spike terjadi), titik Low biasanya terjadi SEBELUM pompa menuju High.
          // Oleh karena itu, jika k === i: TP hanya boleh dieksekusi jika lilin tersebut benar-benar ditutup
          // membentuk ekor jarum ke bawah (c.close <= targetTpPrice).
          // Sedangkan pada lilin-lilin berikutnya (k > i): titik Low terjadi SETELAH pompa, sehingga evalCandle.low <= targetTpPrice 100% valid!
          const canTakeProfit = k === i ? evalCandle.close <= targetTpPrice : evalCandle.low <= targetTpPrice;

          if (canTakeProfit) {
            if (partialTpEnabled && !partialDone && qty > 0) {
              const partQty = qty * partialTpRatio;
              const partPnl = (avgPrice - targetTpPrice) * partQty;
              partialRealizedPnl += partPnl;
              qty -= partQty;
              partialDone = true;

              // Geser SL ke Breakeven (Fee-Inclusive: 0.08% roundtrip fee di bawah Avg Entry untuk SHORT)
              const feeRoundtripRate = 0.0008;
              hardSlPrice = avgPrice * (1 - feeRoundtripRate);
              // Target TP tahap 2 digeser lebih dalam
              targetTpPrice = avgPrice * (1 - (takeProfitPct * 2) / 100);

              // Batalkan layer pending yang tersisa
              for (const l of layers) {
                if (l.status === 'PENDING') {
                  l.status = 'CANCELLED';
                }
              }

              // Jika candle ini juga menembus TP tahap 2
              const canStage2 = k === i ? evalCandle.close <= targetTpPrice : evalCandle.low <= targetTpPrice;
              if (canStage2) {
                tradeClosed = true;
                exitPrice = targetTpPrice;
                exitReason = 'TRAILING_TP';
                exitTime = evalCandle.openTime;
                break;
              }
              continue;
            }

            tradeClosed = true;
            exitPrice = targetTpPrice;
            exitReason = partialDone ? 'TRAILING_TP' : 'TAKE_PROFIT';
            exitTime = evalCandle.openTime;
            break;
          }

          // 4. Jika waktu habis (Max Hold Time)
          if (k === maxIndex) {
            tradeClosed = true;
            exitPrice = evalCandle.close;
            exitReason = 'TIME_LIMIT_EXIT';
            exitTime = evalCandle.openTime;
            break;
          }
        }

        if (tradeClosed) {
          const remainingPnl = (avgPrice - exitPrice) * qty;
          const totalRealizedPnl = Math.round((remainingPnl + partialRealizedPnl) * 100) / 100;
          const pnlPct = usedMargin > 0 ? Math.round((totalRealizedPnl / usedMargin) * 1000) / 10 : 0;
          const durationMinutes = Math.max(1, Math.round((exitTime - entryTime) / 60000));

          balance += totalRealizedPnl;
          if (balance > peakBalance) peakBalance = balance;
          const ddUsdt = peakBalance - balance;
          const ddPct = (ddUsdt / peakBalance) * 100;
          if (ddUsdt > maxDrawdownUsdt) maxDrawdownUsdt = ddUsdt;
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

          const filledCount = layers.filter((l) => l.status === 'FILLED').length;

          allTrades.push({
            id: `bt_${symbol}_${entryTime}`,
            symbol,
            entryTime: new Date(entryTime).toLocaleString('id-ID'),
            exitTime: new Date(exitTime).toLocaleString('id-ID'),
            entryTimestamp: entryTime,
            exitTimestamp: exitTime,
            entryPrice: parseFloat(avgPrice.toFixed(5)),
            exitPrice: parseFloat(exitPrice.toFixed(5)),
            marginUsed: Math.round(usedMargin * 100) / 100,
            realizedPnl: totalRealizedPnl,
            pnlPct,
            exitReason,
            durationMinutes,
            layersFilled: filledCount,
            partialTpTaken: partialDone,
          });

          equityCurve.push({
            time: new Date(exitTime).toLocaleDateString('id-ID'),
            balance: Math.round(balance * 100) / 100,
          });

          // Set cooldown koin ini
          cooldownUntil = exitTime + cooldownMinutes * 60000;
        }
      }
    }

    // Urutkan trades berdasarkan waktu entri
    allTrades.sort((a, b) => a.entryTimestamp - b.entryTimestamp);

    const totalTrades = allTrades.length;
    const winningTrades = allTrades.filter((t) => t.realizedPnl > 0).length;
    const losingTrades = allTrades.filter((t) => t.realizedPnl < 0).length;
    const winRate = totalTrades > 0 ? Math.round((winningTrades / totalTrades) * 1000) / 10 : 0;

    const totalWinsPnl = allTrades.filter((t) => t.realizedPnl > 0).reduce((sum, t) => sum + t.realizedPnl, 0);
    const totalLossPnl = Math.abs(allTrades.filter((t) => t.realizedPnl < 0).reduce((sum, t) => sum + t.realizedPnl, 0));
    const profitFactor = totalLossPnl > 0 ? Math.round((totalWinsPnl / totalLossPnl) * 100) / 100 : totalWinsPnl > 0 ? 99.9 : 0;

    const netProfitUsdt = Math.round((balance - initialBalance) * 100) / 100;
    const netProfitPct = Math.round(((balance - initialBalance) / initialBalance) * 1000) / 10;

    const avgDuration =
      totalTrades > 0 ? Math.round((allTrades.reduce((sum, t) => sum + t.durationMinutes, 0) / totalTrades) * 10) / 10 : 0;

    const partialTpTrades = allTrades.filter((t) => t.partialTpTaken).length;

    return {
      symbols: params.symbols,
      startDate: new Date(params.startTime).toLocaleDateString('id-ID'),
      endDate: new Date(params.endTime).toLocaleDateString('id-ID'),
      totalCandlesAnalyzed,
      initialBalance,
      finalBalance: Math.round(balance * 100) / 100,
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      netProfitUsdt,
      netProfitPct,
      maxDrawdownUsdt: Math.round(maxDrawdownUsdt * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
      profitFactor,
      avgTradeDurationMinutes: avgDuration,
      partialTpTrades,
      trades: allTrades,
      equityCurve,
    };
  }
}

export const backtester = new WickSniperBacktester();
