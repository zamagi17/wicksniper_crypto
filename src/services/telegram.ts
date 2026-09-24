import axios from 'axios';
import { ActivePosition, ClosedTrade, GridLayer } from '../types';
import { logger } from './logger';

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  notifyOnNewOrder?: boolean;
  notifyOnLayerFill?: boolean;
  notifyOnClose?: boolean;
}

export class TelegramService {
  private config: TelegramConfig = {
    enabled: false,
    botToken: '',
    chatId: '',
    notifyOnNewOrder: true,
    notifyOnLayerFill: false,
    notifyOnClose: true,
  };

  public updateConfig(cfg?: Partial<TelegramConfig>) {
    if (!cfg) return;
    this.config = {
      ...this.config,
      ...cfg,
      botToken: (cfg.botToken || this.config.botToken || '').trim(),
      chatId: (cfg.chatId || this.config.chatId || '').trim(),
    };
  }

  public isConfigured(): boolean {
    return !!(this.config.enabled && this.config.botToken && this.config.chatId);
  }

  public async sendMessage(htmlText: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      await axios.post(
        url,
        {
          chat_id: this.config.chatId,
          text: htmlText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 7000 }
      );
      return true;
    } catch (err: any) {
      const msg = err.response?.data?.description || err.message;
      logger.log('WARN', `⚠️ [TELEGRAM] Gagal mengirim pesan: ${msg}`);
      return false;
    }
  }

  public async testConnection(botToken: string, chatId: string): Promise<{ success: boolean; botName?: string; error?: string }> {
    const cleanToken = (botToken || '').trim();
    const cleanChatId = (chatId || '').trim();

    if (!cleanToken || !cleanChatId) {
      return { success: false, error: 'Token Bot dan Chat ID Telegram wajib diisi.' };
    }

    try {
      // 1. Validasi Token Bot via getMe
      const meRes = await axios.get(`https://api.telegram.org/bot${cleanToken}/getMe`, { timeout: 6000 });
      const botUser = meRes.data?.result?.username || 'WickSniperBot';

      // 2. Kirim Pesan Tes ke Chat ID
      const testMsg =
`🎯 <b>WICK SNIPER CRYPTO BOT</b>

✅ <b>Koneksi Telegram Berhasil Terhubung!</b>
🤖 <b>Bot Username:</b> @${botUser}
🕒 <b>Waktu Sistem:</b> ${new Date().toLocaleString('id-ID')}

Notifikasi pembukaan jaring, averaging layer, dan take profit akan langsung dikirimkan ke chat ini secara realtime. 🚀`;

      await axios.post(
        `https://api.telegram.org/bot${cleanToken}/sendMessage`,
        {
          chat_id: cleanChatId,
          text: testMsg,
          parse_mode: 'HTML',
        },
        { timeout: 6000 }
      );

      return { success: true, botName: botUser };
    } catch (err: any) {
      const errorDetail = err.response?.data?.description || err.message;
      return { success: false, error: errorDetail };
    }
  }

  /**
   * Notifikasi saat Spike Terdeteksi & Jaring Order Baru Diterbitkan
   */
  public async notifyNewOrder(
    pos: ActivePosition,
    tradingMode: string,
    surgePct: number,
    lookbackSeconds: number,
    spacingPct: number,
    tpPct: number,
    slPct: number
  ) {
    if (!this.config.notifyOnNewOrder) return;

    const modeTag = tradingMode === 'LIVE' ? '🟢 <b>LIVE FUTURES</b>' : '🧪 <b>PAPER TRADING</b>';
    const msg =
`🚀 <b>[ORDER BARU DITERBITKAN]</b> 🎯

🪙 <b>Koin:</b> <code>${pos.symbol}</code>
📊 <b>Aksi:</b> <b>SHORT ${pos.leverage}x</b>
⚡ <b>Spike Lonjakan:</b> <b>+${surgePct}%</b> (${lookbackSeconds}s)
💵 <b>Layer #0 Entry:</b> <code>$${pos.avgEntryPrice.toFixed(4)}</code>
🕸️ <b>Jaring Terpasang:</b> ${pos.layers.length} Layer (Jarak ${spacingPct}%)
💰 <b>Modal Awal Layer #0:</b> $${pos.totalMarginUsed.toFixed(2)} USDT
🎯 <b>Target TP:</b> <code>$${pos.targetTpPrice.toFixed(4)}</code> (-${tpPct}%)
🛑 <b>Hard SL:</b> <code>$${pos.hardSlPrice.toFixed(4)}</code> (+${slPct}%)
⚙️ <b>Mode:</b> ${modeTag}`;

    this.sendMessage(msg).catch(() => {});
  }

  /**
   * Notifikasi saat Layer Grid Pending Terisi (Averaging Down)
   */
  public async notifyLayerFill(pos: ActivePosition, layer: GridLayer, filledCount: number, totalCount: number) {
    if (!this.config.notifyOnLayerFill) return;
    // Layer-fill notifications are intentionally muted by default because they are noisy and better kept in local logs/audit trails.
  }

  /**
   * Notifikasi saat Posisi Ditutup (Take Profit / Stop Loss / Batas Waktu / Manual)
   */
  public async notifyTradeClosed(trade: ClosedTrade, currentBalance?: number) {
    if (!this.config.notifyOnClose) return;

    const isProfit = trade.realizedPnl >= 0;
    const emoji = isProfit ? '🎯' : '🛑';
    const title = isProfit ? 'TAKE PROFIT (CUAN)' : 'POSISI DITUTUP';
    const pnlSign = isProfit ? '+' : '';
    const modeTag = trade.isPaper ? '🧪 PAPER TRADING' : '🟢 LIVE FUTURES';

    const reasonLabel =
      trade.exitReason === 'TAKE_PROFIT'
        ? '🎯 Take Profit (Pullback Wick)'
        : trade.exitReason === 'TRAILING_TP'
        ? '📈 Trailing Take Profit'
        : trade.exitReason === 'HARD_STOP_LOSS'
        ? '🛑 Hard Stop Loss (Cut-Off)'
        : trade.exitReason === 'FEE_LOSS_EXIT'
        ? '💸 TP Minus Fee (Biaya > Profit)'
        : trade.exitReason === 'TIME_LIMIT_EXIT'
        ? '⏰ Batas Waktu Hold'
        : '⚡ Tutup Manual';

    const durationMin = Math.floor(trade.durationSeconds / 60);
    const durationSec = trade.durationSeconds % 60;
    const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`;

    const balanceLine = currentBalance !== undefined ? `\n💼 <b>Saldo Akun:</b> $${currentBalance.toFixed(2)} USDT` : '';
    const feeLine = trade.fee && trade.fee > 0 ? `\n💸 <b>Fee Binance:</b> -$${trade.fee.toFixed(4)} USDT` : '';
    const grossPnlLine = trade.grossPnl !== undefined && trade.fee && trade.fee > 0
      ? `\n📊 <b>Gross PnL:</b> ${trade.grossPnl >= 0 ? '+' : ''}$${trade.grossPnl.toFixed(2)} USDT`
      : '';

    const msg =
`${emoji} <b>[${title}]</b> ${emoji}

🪙 <b>Koin:</b> <code>${trade.symbol}</code> SHORT
🏁 <b>Alasan Exit:</b> ${reasonLabel}
💵 <b>Harga:</b> <code>$${trade.entryPrice}</code> ➜ <code>$${trade.exitPrice}</code>
⏱️ <b>Durasi Trade:</b> ${durationStr}
🕸️ <b>Layer Terisi:</b> ${trade.layersFilled} Layer
💰 <b>Margin Dipakai:</b> $${trade.marginUsed.toFixed(2)} USDT${grossPnlLine}${feeLine}

💵 <b>Net Realized PnL:</b> <b>${pnlSign}$${trade.realizedPnl.toFixed(2)} USDT (${pnlSign}${trade.pnlPct.toFixed(1)}%)</b>${balanceLine}
⚙️ <b>Mode:</b> ${modeTag}`;

    this.sendMessage(msg).catch(() => {});
  }

  /**
   * Notifikasi Stage 1 Partial Take Profit 50%
   */
  public async notifyPartialTp(symbol: string, partialPnl: number, remainingQty: number, bepPrice: number, tp2Price: number) {
    // Partial TP notifications are intentionally kept minimal, while the full local audit remains in logger/dashboard.
  }

  /**
   * Notifikasi saat Saldo Margin Kurang / Jaring Gagal Terpasang
   */
  public async notifyMarginInsufficient(
    symbol: string,
    action: string,
    details: {
      placedLayers?: number;
      totalLayers?: number;
      reason?: string;
      availableBalance?: number;
      requiredAmount?: number;
    }
  ) {
    const balanceStr = details.availableBalance !== undefined ? `$${details.availableBalance.toFixed(2)} USDT` : 'Tidak diketahui';
    const layerStr = details.placedLayers !== undefined && details.totalLayers !== undefined
      ? `\n📊 <b>Jaring Berhasil:</b> ${details.placedLayers}/${details.totalLayers} Layer Terpasang`
      : '';
    const reqStr = details.requiredAmount !== undefined
      ? `\n💵 <b>Estimasi Butuh:</b> ~$${details.requiredAmount.toFixed(2)} USDT`
      : '';
    const reasonStr = details.reason ? `\n❌ <b>Penyebab:</b> <code>${details.reason}</code>` : '';

    const msg =
`⚠️ <b>[PERINGATAN SALDO / MARGIN KURANG]</b> ⚠️

🪙 <b>Koin:</b> <code>${symbol}</code>
⚡ <b>Aksi:</b> ${action}${layerStr}
💰 <b>Saldo Bebas (Available):</b> <b>${balanceStr}</b>${reqStr}${reasonStr}

⚠️ <i>Perhatian: Sebagian/seluruh jaring limit tidak terpasang di Binance! Cek saldo wallet Futures Anda untuk menghindari posisi berjalan tanpa jaring pengaman.</i>`;

    this.sendMessage(msg).catch(() => {});
  }
}

export const telegram = new TelegramService();
