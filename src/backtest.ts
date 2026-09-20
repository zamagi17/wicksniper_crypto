import { backtester, BacktestParams } from './services/backtester';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string, def: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const symbolArg = getArg('--symbol', 'AKEUSDT,CROSSUSDT,BTWUSDT');
  const daysArg = parseInt(getArg('--days', '7'), 10);
  const startDateArg = getArg('--startDate', '');
  const endDateArg = getArg('--endDate', '');
  const leverageArg = parseFloat(getArg('--leverage', '5'));
  const spikeArg = parseFloat(getArg('--spike', '3.2'));
  const tpArg = parseFloat(getArg('--tp', '1.2'));
  const slArg = parseFloat(getArg('--sl', '4.5'));
  const marginArg = parseFloat(getArg('--margin', '5'));
  const maxMarginArg = parseFloat(getArg('--maxMargin', '35'));

  const symbols = symbolArg.split(',').map((s) => s.trim().toUpperCase());

  const now = Date.now();
  let startTime = now - daysArg * 24 * 60 * 60 * 1000;
  let endTime = now;

  if (startDateArg) {
    startTime = new Date(startDateArg).getTime();
  }
  if (endDateArg) {
    endTime = new Date(endDateArg).getTime();
  }

  console.log('\n======================================================');
  console.log('🧪 WICK SNIPER HISTORICAL BACKTEST LAB');
  console.log('======================================================');
  console.log(`📊 Target Koin     : ${symbols.join(', ')}`);
  console.log(`📅 Periode         : ${new Date(startTime).toLocaleString('id-ID')} ➜ ${new Date(endTime).toLocaleString('id-ID')}`);
  console.log(`⚙️  Pengaturan      : Leverage ${leverageArg}x | Spike >= +${spikeArg}% | TP ${tpArg}% | Hard SL ${slArg}% | Margin/Layer $${marginArg}`);
  console.log('⏳ Mengunduh data historis 1m klines dari Binance Futures...\n');

  const params: BacktestParams = {
    symbols,
    startTime,
    endTime,
    leverage: leverageArg,
    spikeMinPercent: spikeArg,
    takeProfitPct: tpArg,
    hardStopLossPct: slArg,
    marginPerLayerUsdt: marginArg,
    maxTotalMarginPerCoin: maxMarginArg,
    partialTpEnabled: true,
    partialTpRatio: 0.5,
  };

  const res = await backtester.run(params);

  console.log('======================================================');
  console.log('📈 HASIL PERFORMA BACKTEST (WICK SNIPER LAB)');
  console.log('======================================================');
  console.log(`Total Lilin Dianalisa : ${res.totalCandlesAnalyzed.toLocaleString()} lilin 1-menit`);
  console.log(`Saldo Awal            : $${res.initialBalance.toFixed(2)} USDT`);
  console.log(`Saldo Akhir           : $${res.finalBalance.toFixed(2)} USDT`);
  console.log(`Total Keuntungan Bersih: ${res.netProfitUsdt >= 0 ? '+' : ''}$${res.netProfitUsdt.toFixed(2)} USDT (${res.netProfitPct >= 0 ? '+' : ''}${res.netProfitPct}%)`);
  console.log(`Total Transaksi (Trades): ${res.totalTrades}`);
  console.log(`Menang / Kalah        : ${res.winningTrades} Menang / ${res.losingTrades} Kalah`);
  console.log(`Win Rate              : ${res.winRate.toFixed(1)}%`);
  console.log(`Profit Factor         : ${res.profitFactor}`);
  console.log(`Max Drawdown          : -$${res.maxDrawdownUsdt.toFixed(2)} (-${res.maxDrawdownPct.toFixed(1)}%)`);
  console.log(`Rata-rata Durasi Trade: ${res.avgTradeDurationMinutes} menit`);
  console.log('======================================================\n');

  if (res.trades.length > 0) {
    console.log('📜 DAFTAR 15 TRADE TERAKHIR:');
    console.log('-----------------------------------------------------------------------------------------');
    console.log('Waktu                Simbol       Margin    Entry ➜ Exit          Durasi  PnL (USDT)    Alasan');
    console.log('-----------------------------------------------------------------------------------------');
    res.trades.slice(-15).forEach((t) => {
      const pnlStr = `${t.realizedPnl >= 0 ? '+' : ''}$${t.realizedPnl.toFixed(2)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%)`;
      const timePad = t.entryTime.padEnd(20);
      const symPad = t.symbol.padEnd(12);
      const marginPad = `$${t.marginUsed.toFixed(2)}`.padEnd(10);
      const pricePad = `$${t.entryPrice} ➜ $${t.exitPrice}`.padEnd(22);
      const durPad = `${t.durationMinutes}m`.padEnd(8);
      const pnlPad = pnlStr.padEnd(14);
      console.log(`${timePad} ${symPad} ${marginPad} ${pricePad} ${durPad} ${pnlPad} ${t.exitReason}`);
    });
    console.log('-----------------------------------------------------------------------------------------\n');
  } else {
    console.log('ℹ️  Tidak ada lonjakan yang memenuhi ambang pemicu spike pada periode ini.\n');
  }
}

main().catch((err) => {
  console.error('Terjadi kesalahan:', err.message);
});
