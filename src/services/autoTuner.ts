import { BotConfig, ClosedTrade, TuningProposal, TuningHistoryRecord } from '../types';
import { logger } from './logger';
import { db } from './db';
import crypto from 'crypto';

export interface ParamGuardrail {
  min: number;
  max: number;
  default: number;
  step: number;
  unit: string;
  label: string;
}

export const PARAM_GUARDRAILS: Record<string, ParamGuardrail> = {
  spikeMinPercent: {
    min: 1.5,
    max: 5.0,
    default: 2.0,
    step: 0.1,
    unit: '%',
    label: 'Min Lonjakan Harga (Spike %)',
  },
  takeProfitPct: {
    min: 0.8,
    max: 3.5,
    default: 1.2,
    step: 0.05,
    unit: '%',
    label: 'Take Profit Target (%)',
  },
  layerSpacingPct: {
    min: 0.8,
    max: 2.5,
    default: 1.2,
    step: 0.05,
    unit: '%',
    label: 'Jarak Antar Layer Grid (%)',
  },
  trailingCallbackPct: {
    min: 0.2,
    max: 1.0,
    default: 0.3,
    step: 0.05,
    unit: '%',
    label: 'Trailing TP Callback (%)',
  },
  minRsi1m: {
    min: 50,
    max: 85,
    default: 60,
    step: 1,
    unit: '',
    label: 'Filter RSI Minimum (1m)',
  },
  maxVolRatio: {
    min: 5,
    max: 40,
    default: 20,
    step: 1,
    unit: 'x',
    label: 'Batas Rasio Volume Maksimal',
  },
  maxHoldMinutes: {
    min: 15,
    max: 180,
    default: 45,
    step: 5,
    unit: 'm',
    label: 'Batas Waktu Hold (Menit)',
  },
};

export class AutoTunerService {
  private activeProposal: TuningProposal | null = null;
  private lastTuningRecord: TuningHistoryRecord | null = null;
  private lastAnalysisAt: number = 0;
  private isAnalyzing: boolean = false;

  constructor() {
    this.loadLatestHistory().catch(() => {});
  }

  private async loadLatestHistory() {
    const logs = await db.loadTuningLogs(5);
    if (logs && logs.length > 0) {
      this.lastTuningRecord = logs.find((l) => l.status === 'APPLIED') || logs[0];
      const pending = logs.find((l) => l.status === 'PROPOSED');
      if (pending) {
        this.activeProposal = pending.proposal;
      }
    }
  }

  public getActiveProposal(): TuningProposal | null {
    return this.activeProposal;
  }

  public getLastTuningRecord(): TuningHistoryRecord | null {
    return this.lastTuningRecord;
  }

  public getStatus() {
    return {
      activeProposal: this.activeProposal,
      lastTuningRecord: this.lastTuningRecord,
      lastAnalysisAt: this.lastAnalysisAt,
      isAnalyzing: this.isAnalyzing,
      guardrails: PARAM_GUARDRAILS,
    };
  }

  /**
   * Clamp nilai ke batasan batas aman absolut & step terdekat
   */
  private clampValue(key: string, value: number): number {
    const rail = PARAM_GUARDRAILS[key];
    if (!rail) return value;
    const clamped = Math.max(rail.min, Math.min(rail.max, value));
    const inv = 1 / rail.step;
    return Math.round(clamped * inv) / inv;
  }

  /**
   * Batasi perubahan maksimal per step (default max ±10% dari nilai sebelumnya)
   */
  private limitStepChange(currentVal: number, targetVal: number, maxStepPct: number = 10): number {
    const maxDelta = Math.abs(currentVal * (maxStepPct / 100));
    const delta = targetVal - currentVal;
    if (Math.abs(delta) > maxDelta) {
      return delta > 0 ? currentVal + maxDelta : currentVal - maxDelta;
    }
    return targetVal;
  }

  /**
   * Analisis riwayat trade untuk menghasilkan rekomendasi TuningProposal
   */
  public async analyzeTrades(
    trades: ClosedTrade[],
    currentConfig: BotConfig
  ): Promise<{ success: boolean; proposal?: TuningProposal; message: string }> {
    if (this.isAnalyzing) {
      return { success: false, message: 'Analisis Auto-Tuner sedang berjalan.' };
    }

    this.isAnalyzing = true;
    try {
      const tunerCfg = currentConfig.autoTuner || {
        enabled: true,
        mode: 'SEMI_AUTO',
        minSampleSize: 15,
        evalPeriodDays: 7,
        stepSizePct: 10,
      };

      const minSample = tunerCfg.minSampleSize || 15;
      const evalDays = tunerCfg.evalPeriodDays || 7;
      const cutoffTime = Date.now() - evalDays * 24 * 60 * 60 * 1000;

      // Filter trade dalam periode evaluasi (khusus strategi Wick Sniper agar tidak tercampur Smart Money)
      const relevantTrades = trades.filter((t) => t.timestamp >= cutoffTime && (!t.strategyType || t.strategyType === 'WICK_SNIPER'));

      if (relevantTrades.length < minSample) {
        const msg = `Riwayat trade belum mencukupi (Tersedia ${relevantTrades.length}/${minSample} trade dalam ${evalDays} hari terakhir).`;
        return { success: false, message: msg };
      }

      // Hitung metrik agregat
      const winners = relevantTrades.filter((t) => t.realizedPnl > 0);
      const losers = relevantTrades.filter((t) => t.realizedPnl <= 0);
      const winRateBefore = (winners.length / relevantTrades.length) * 100;

      const grossWins = winners.reduce((sum, t) => sum + t.realizedPnl, 0);
      const grossLosses = Math.abs(losers.reduce((sum, t) => sum + t.realizedPnl, 0));
      const profitFactorBefore = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99.0 : 1.0;

      const avgPnlPctBefore =
        relevantTrades.reduce((sum, t) => sum + t.pnlPct, 0) / relevantTrades.length;

      const hardStopCount = relevantTrades.filter((t) => t.exitReason === 'HARD_STOP_LOSS').length;
      const timeLimitCount = relevantTrades.filter((t) => t.exitReason === 'TIME_LIMIT_EXIT').length;

      // Parameter bot saat ini
      const currentParams: Record<string, number> = {
        spikeMinPercent: currentConfig.scanner?.spikeMinPercent ?? PARAM_GUARDRAILS.spikeMinPercent.default,
        takeProfitPct: currentConfig.exit?.takeProfitPct ?? PARAM_GUARDRAILS.takeProfitPct.default,
        layerSpacingPct: currentConfig.grid?.layerSpacingPct ?? PARAM_GUARDRAILS.layerSpacingPct.default,
        trailingCallbackPct: currentConfig.exit?.trailingCallbackPct ?? PARAM_GUARDRAILS.trailingCallbackPct.default,
        minRsi1m: currentConfig.scanner?.minRsi1m ?? PARAM_GUARDRAILS.minRsi1m.default,
        maxVolRatio: currentConfig.scanner?.maxVolRatio ?? PARAM_GUARDRAILS.maxVolRatio.default,
        maxHoldMinutes: currentConfig.exit?.maxHoldMinutes ?? PARAM_GUARDRAILS.maxHoldMinutes.default,
      };

      const proposedParams: Record<string, number> = { ...currentParams };
      const rationale: string[] = [];
      const stepPct = tunerCfg.stepSizePct || 10;
      const allowed = tunerCfg.targetParams || {
        spikeMinPercent: true,
        takeProfitPct: true,
        layerSpacingPct: true,
        trailingCallbackPct: true,
        minRsi1m: true,
        maxVolRatio: true,
        maxHoldMinutes: true,
      };

      // ==============================================================
      // 1. EVALUASI TAKE PROFIT (TP)
      // ==============================================================
      if (allowed.takeProfitPct !== false) {
        if (winRateBefore >= 80 && profitFactorBefore >= 2.0 && timeLimitCount <= 1) {
          // Win rate sangat tinggi dan jarang timeout -> potensi menambah TP sedikit
          const target = this.limitStepChange(currentParams.takeProfitPct, currentParams.takeProfitPct + 0.15, stepPct);
          proposedParams.takeProfitPct = this.clampValue('takeProfitPct', target);
          if (proposedParams.takeProfitPct !== currentParams.takeProfitPct) {
            rationale.push(
              `Win Rate tinggi (${winRateBefore.toFixed(1)}%) & Profit Factor prima (${profitFactorBefore.toFixed(2)}): TP dinaikkan bertahap untuk memaksimalkan yield pembalikan harga.`
            );
          }
        } else if (winRateBefore < 60 || timeLimitCount > relevantTrades.length * 0.25) {
          // Banyak time limit atau win rate di bawah 60% -> percepat panen profit
          const target = this.limitStepChange(currentParams.takeProfitPct, currentParams.takeProfitPct - 0.1, stepPct);
          proposedParams.takeProfitPct = this.clampValue('takeProfitPct', target);
          if (proposedParams.takeProfitPct !== currentParams.takeProfitPct) {
            rationale.push(
              `Terdapat ${timeLimitCount} trade Time-Limit Exit: TP diturunkan sedikit agar target profit lebih mudah tersentuh sebelum momentum habis.`
            );
          }
        }
      }

      // ==============================================================
      // 2. EVALUASI HARD SL & LAYER SPACING
      // ==============================================================
      if (allowed.layerSpacingPct !== false) {
        if (hardStopCount >= 2 || (hardStopCount / relevantTrades.length) >= 0.15) {
          // Terlalu sering kena Hard SL -> grid layer terlalu rapat menahan pump agresif
          const target = this.limitStepChange(currentParams.layerSpacingPct, currentParams.layerSpacingPct + 0.15, stepPct);
          proposedParams.layerSpacingPct = this.clampValue('layerSpacingPct', target);
          if (proposedParams.layerSpacingPct !== currentParams.layerSpacingPct) {
            rationale.push(
              `Terdeteksi ${hardStopCount} trade menyentuh Hard Stop Loss: Jarak layer dinaikkan untuk meredam lonjakan koin yang terus memanjang.`
            );
          }
        } else if (hardStopCount === 0 && winRateBefore >= 85) {
          // Aman tanpa SL, jarak bisa dipertahankan atau diperketat halus
          proposedParams.layerSpacingPct = currentParams.layerSpacingPct;
        }
      }

      // ==============================================================
      // 3. EVALUASI MINIMUM SPIKE %
      // ==============================================================
      if (allowed.spikeMinPercent !== false) {
        // Cek apakah trade loss rata-rata terjadi pada spike rendah
        const losingSpikes = losers
          .map((t) => t.marketSnapshot?.surgePct || t.paramsSnapshot?.spikeMinPercent)
          .filter((v): v is number => typeof v === 'number' && !isNaN(v));

        const avgLoserSpike = losingSpikes.length > 0 ? losingSpikes.reduce((a, b) => a + b, 0) / losingSpikes.length : 0;

        if (avgLoserSpike > 0 && avgLoserSpike < 2.5 && losers.length >= 2) {
          const target = this.limitStepChange(currentParams.spikeMinPercent, currentParams.spikeMinPercent + 0.2, stepPct);
          proposedParams.spikeMinPercent = this.clampValue('spikeMinPercent', target);
          if (proposedParams.spikeMinPercent !== currentParams.spikeMinPercent) {
            rationale.push(
              `Trade merugi sering terpicu pada lonjakan kecil (< 2.5%): Syarat lonjakan spike minimum dinaikkan untuk menyaring false-breakout.`
            );
          }
        }
      }

      // ==============================================================
      // 4. EVALUASI MAX HOLD MINUTES
      // ==============================================================
      if (allowed.maxHoldMinutes !== false) {
        if (timeLimitCount >= 3) {
          // Perpanjang hold time sedikit agar trade sempat pull-back
          const target = this.limitStepChange(currentParams.maxHoldMinutes, currentParams.maxHoldMinutes + 15, stepPct);
          proposedParams.maxHoldMinutes = this.clampValue('maxHoldMinutes', target);
          if (proposedParams.maxHoldMinutes !== currentParams.maxHoldMinutes) {
            rationale.push(
              `Terdapat ${timeLimitCount} trade terkena batas waktu: Max Hold diperpanjang +15m untuk memberi ruang pembalikan wick lebih optimal.`
            );
          }
        }
      }

      // ==============================================================
      // 5. EVALUASI TRAILING CALLBACK
      // ==============================================================
      if (allowed.trailingCallbackPct !== false) {
        const trailingExits = relevantTrades.filter((t) => t.exitReason === 'TRAILING_TP');
        if (trailingExits.length >= 4) {
          const avgTrailingPnl = trailingExits.reduce((sum, t) => sum + t.pnlPct, 0) / trailingExits.length;
          if (avgTrailingPnl < 0.8) {
            // Callback terlalu rapat, sering terpicu oleh noise
            const target = this.limitStepChange(currentParams.trailingCallbackPct, currentParams.trailingCallbackPct + 0.05, stepPct);
            proposedParams.trailingCallbackPct = this.clampValue('trailingCallbackPct', target);
            if (proposedParams.trailingCallbackPct !== currentParams.trailingCallbackPct) {
              rationale.push(
                `Trailing TP sering ter-trigger prematur pada pullback tipis: Callback dinaikkan sedikit agar tidak mudah terpancing noise pasar.`
              );
            }
          }
        }
      }

      // Hitung delta
      const deltas: Record<string, number> = {};
      let hasChange = false;
      for (const [k, v] of Object.entries(proposedParams)) {
        const delta = Math.round((v - currentParams[k]) * 1000) / 1000;
        deltas[k] = delta;
        if (Math.abs(delta) > 0.0001) hasChange = true;
      }

      if (!hasChange) {
        if (rationale.length === 0) {
          rationale.push('Performa parameter saat ini sudah optimal dan seimbang dengan kondisi pasar.');
        }
      }

      const proposalId = `tune_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const proposal: TuningProposal = {
        id: proposalId,
        createdAt: Date.now(),
        status: 'PROPOSED',
        currentParams,
        proposedParams,
        deltas,
        rationale,
        metrics: {
          totalTradesAnalyzed: relevantTrades.length,
          winRateBefore: Math.round(winRateBefore * 10) / 10,
          avgPnlPctBefore: Math.round(avgPnlPctBefore * 100) / 100,
          profitFactorBefore: Math.round(profitFactorBefore * 100) / 100,
          winnersCount: winners.length,
          losersCount: losers.length,
          hardStopExitsCount: hardStopCount,
          timeLimitExitsCount: timeLimitCount,
        },
      };

      this.activeProposal = proposal;
      this.lastAnalysisAt = Date.now();

      // Simpan log proposal ke DB
      const record: TuningHistoryRecord = {
        id: proposal.id,
        proposal,
        previousConfigSnapshot: {
          scanner: { ...currentConfig.scanner },
          exit: { ...currentConfig.exit },
          grid: { ...currentConfig.grid },
        },
        status: 'PROPOSED',
        createdAt: proposal.createdAt,
      };
      await db.saveTuningLog(record).catch(() => {});

      logger.log(
        'INFO',
        `🧠 Auto-Tuner selesai menganalisis ${relevantTrades.length} trade: ${rationale.length} rekomendasi dihasilkan.`
      );

      return {
        success: true,
        proposal,
        message: hasChange
          ? `Rekomendasi parameter berhasil dibuat berdasarkan ${relevantTrades.length} trade.`
          : 'Parameter saat ini sudah seimbang dengan ritme pasar, belum diperlukan perubahan.',
      };
    } catch (e: any) {
      logger.log('ERROR', `Gagal mengeksekusi analisis Auto-Tuner: ${e.message}`);
      return { success: false, message: e.message };
    } finally {
      this.isAnalyzing = false;
    }
  }

  /**
   * Cek apakah rangkaian trade terakhir memicu Circuit Breaker (loss beruntun setelah tuning)
   */
  public checkCircuitBreaker(
    recentTrades: ClosedTrade[],
    threshold: number = 3
  ): { triggered: boolean; consecutiveLosses: number } {
    if (!this.lastTuningRecord || this.lastTuningRecord.status !== 'APPLIED') {
      return { triggered: false, consecutiveLosses: 0 };
    }

    const appliedAt = this.lastTuningRecord.appliedAt || 0;
    // Ambil trade yang ditutup setelah tuning diaplikasikan (urutkan terbaru ke terlama)
    const tradesAfterTuning = recentTrades
      .filter((t) => t.timestamp > appliedAt)
      .sort((a, b) => b.timestamp - a.timestamp);

    let consecutiveLosses = 0;
    for (const t of tradesAfterTuning) {
      if (t.realizedPnl < 0) {
        consecutiveLosses++;
      } else {
        break; // Rentetan kekalahan terputus jika ada trade profit
      }
    }

    return {
      triggered: consecutiveLosses >= threshold,
      consecutiveLosses,
    };
  }

  /**
   * Tandai proposal telah diaplikasikan
   */
  public async markProposalApplied(
    proposal: TuningProposal,
    previousConfigSnapshot: Record<string, any>
  ): Promise<TuningHistoryRecord> {
    proposal.status = 'APPLIED';
    proposal.appliedAt = Date.now();

    const record: TuningHistoryRecord = {
      id: proposal.id,
      proposal,
      previousConfigSnapshot,
      status: 'APPLIED',
      appliedAt: proposal.appliedAt,
      createdAt: proposal.createdAt,
    };

    this.lastTuningRecord = record;
    this.activeProposal = null;

    await db.saveTuningLog(record);
    return record;
  }

  /**
   * Tandai proposal telah di-rollback
   */
  public async markRollback(recordId: string): Promise<void> {
    if (this.lastTuningRecord && this.lastTuningRecord.id === recordId) {
      this.lastTuningRecord.status = 'ROLLED_BACK';
    }
    await db.updateTuningStatus(recordId, 'ROLLED_BACK');
  }
}

export const autoTuner = new AutoTunerService();
