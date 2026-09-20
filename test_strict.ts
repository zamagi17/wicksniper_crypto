import { dataFetcher } from './src/services/dataFetcher';

async function testStrict() {
  const symbols = ['AKEUSDT', 'CROSSUSDT', 'BTWUSDT'];
  const now = Date.now();
  const startTime = now - 30 * 24 * 60 * 60 * 1000;
  const endTime = now;

  const leverage = 5;
  const spikeMinPercent = 3.2;
  const takeProfitPct = 1.2;
  const hardStopLossPct = 4.5;
  const marginPerLayerUsdt = 5;
  const maxTotalMargin = 35;
  const layerSpacingPct = 1.0;
  const maxHoldMinutes = 10;
  const cooldownMinutes = 10;

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let netPnl = 0;
  let durations: number[] = [];

  for (const sym of symbols) {
    const candles = await dataFetcher.getKlines(sym, '1m', startTime, endTime);
    let cooldownUntil = 0;

    for (let i = 2; i < candles.length; i++) {
      const c = candles[i];
      if (c.openTime < cooldownUntil) continue;

      const prevC = candles[i - 1];
      const surgeFromOpen = ((c.high - c.open) / c.open) * 100;
      const surgeFromPrevClose = ((c.high - prevC.close) / prevC.close) * 100;
      const surge = Math.max(surgeFromOpen, surgeFromPrevClose);

      if (surge < spikeMinPercent) continue;

      // Spike detected!
      const layer0Price = c.open + (c.high - c.open) * 0.7;
      let avgPrice = layer0Price;
      let qty = (marginPerLayerUsdt * leverage) / layer0Price;
      let usedMargin = marginPerLayerUsdt;
      let targetTpPrice = avgPrice * (1 - takeProfitPct / 100);
      let hardSlPrice = avgPrice * (1 + hardStopLossPct / 100);

      const maxK = Math.min(candles.length - 1, i + maxHoldMinutes);
      let closed = false;
      let exitP = 0;
      let reason = '';
      let exitTime = c.openTime;

      for (let k = i; k <= maxK; k++) {
        const ec = candles[k];

        // SL check
        if (ec.high >= hardSlPrice) {
          closed = true;
          exitP = hardSlPrice;
          reason = 'SL';
          exitTime = ec.openTime;
          break;
        }

        // TP check: on candle i, only close if close <= TP. On k > i, low <= TP
        const tpReached = (k === i) ? (ec.close <= targetTpPrice) : (ec.low <= targetTpPrice);
        if (tpReached) {
          closed = true;
          exitP = targetTpPrice;
          reason = 'TP';
          exitTime = ec.openTime;
          break;
        }

        if (k === maxK) {
          closed = true;
          exitP = ec.close;
          reason = 'TIMEOUT';
          exitTime = ec.openTime;
          break;
        }
      }

      if (closed) {
        totalTrades++;
        const pnl = (avgPrice - exitP) * qty;
        netPnl += pnl;
        const dur = Math.max(1, Math.round((exitTime - c.openTime) / 60000));
        durations.push(dur);
        if (pnl > 0) wins++;
        else losses++;
        cooldownUntil = exitTime + cooldownMinutes * 60000;
      }
    }
  }

  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  console.log(`STRICT BACKTEST (NO LOOKAHEAD BIAS):`);
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Wins: ${wins}, Losses: ${losses}`);
  console.log(`Win Rate: ${((wins / totalTrades) * 100).toFixed(1)}%`);
  console.log(`Net PnL: $${netPnl.toFixed(2)}`);
  console.log(`Avg Duration: ${avgDur.toFixed(1)} minutes`);
}

testStrict().catch(console.error);
