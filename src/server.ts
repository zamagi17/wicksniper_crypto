import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { WickSniperEngine } from './services/engine';
import { logger } from './services/logger';
import { backtester } from './services/backtester';
import { dataFetcher } from './services/dataFetcher';
import { binanceFutures } from './services/binance';
import { telegram } from './services/telegram';
import { db } from './services/db';

import crypto from 'crypto';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

import { EngineManager } from './services/engineManager';

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
export const engineManager = new EngineManager(CONFIG_PATH);
export const engine = engineManager.getPrimaryEngine();

export interface UserSession {
  userId: string;
  username: string;
  role: 'ADMIN' | 'USER';
  displayName: string;
  expiresAt: number;
}

// Sesi Token Login (Token -> UserSession)
const activeSessions = new Map<string, UserSession>();
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // Sesi aktif selama 7 hari
const loginAttempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const HOST = process.env.HOST || '127.0.0.1';
const REQUIRE_STRONG_REMOTE_PASSWORD = process.env.DASHBOARD_REMOTE_ACCESS === 'true'
  || (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && process.env.DASHBOARD_REMOTE_ACCESS !== 'false');

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function getSession(token?: string | null): UserSession | null {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

function isValidToken(token?: string | null): boolean {
  return !!getSession(token);
}

function extractToken(req: express.Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers['x-auth-token']) {
    return String(req.headers['x-auth-token']).trim();
  }
  if (req.query.token) {
    return String(req.query.token).trim();
  }
  return null;
}

// Middleware Proteksi Akses API Sensitif
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = extractToken(req);
  const session = getSession(token);
  if (session) {
    (req as any).user = session;
    return next();
  }
  return res.status(401).json({
    success: false,
    message: 'Akses ditolak: Harap masukkan password login dashboard terlebih dahulu.',
  });
}

// Middleware opsional untuk melampirkan user jika token disertakan (misal /api/status)
function attachAuthIfPresent(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const token = extractToken(req);
  const session = getSession(token);
  if (session) {
    (req as any).user = session;
  }
  return next();
}

// Middleware khusus aksi Master Admin
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user as UserSession | undefined;
  if (!user || user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Akses khusus Master Administrator.' });
  }
  return next();
}

// Helper untuk meresolusi Engine target berdasarkan user context atau profileId (Multi-User R&D)
function getTargetEngine(req: express.Request): WickSniperEngine {
  const user = (req as any).user as UserSession | undefined;
  const requestedProfile = (req.query.profileId as string) || (req.headers['x-profile-id'] as string) || (req.body?.profileId as string);

  if (user && user.role !== 'ADMIN') {
    return engineManager.getEngine(user.userId);
  }

  if (requestedProfile && engineManager.hasEngine(requestedProfile)) {
    return engineManager.getEngine(requestedProfile);
  }

  return engine;
}

function getSafeConfig(config: any) {
  const safe = { ...config };
  if (safe.security) {
    safe.security = {
      hasPassword: !!safe.security.password,
    };
  }
  return safe;
}

app.use(cors());
app.use(express.json());
app.use(
  express.static(path.resolve(__dirname, '../public'), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  })
);

// ==========================================
// AUTHENTICATION APIs
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let attempt = loginAttempts.get(clientIp);
  if (!attempt || now - attempt.windowStartedAt >= LOGIN_WINDOW_MS) {
    attempt = { count: 0, windowStartedAt: now, blockedUntil: 0 };
    loginAttempts.set(clientIp, attempt);
  }
  if (attempt.blockedUntil > now) {
    return res.status(429).json({ success: false, message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' });
  }

  const { username, password } = req.body || {};
  const targetUsername = (username || 'admin').trim();

  if (!password) {
    return res.status(400).json({ success: false, message: 'Password wajib diisi.' });
  }

  const user = await engineManager.authenticate(targetUsername, password);
  if (!user) {
    attempt.count++;
    if (attempt.count >= LOGIN_ATTEMPT_LIMIT) attempt.blockedUntil = now + LOGIN_BLOCK_MS;
    logger.log('WARN', `⚠️ Percobaan login gagal untuk user '${targetUsername}'.`);
    return res.status(401).json({ success: false, message: 'Username atau password salah! Periksa kembali kredensial Anda.' });
  }

  loginAttempts.delete(clientIp);
  const token = generateToken();
  activeSessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    expiresAt: Date.now() + SESSION_DURATION_MS,
  });

  logger.log('SUCCESS', `🔓 Login berhasil: ${user.displayName} (@${user.username}) [${user.role}]. Sesi otentikasi aktif.`);
  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    },
    message: `Selamat datang di Wick Sniper Terminal, ${user.displayName}!`,
  });
});

app.get('/api/auth/check', (req, res) => {
  const token = extractToken(req);
  const session = getSession(token);
  if (session) {
    return res.json({
      success: true,
      authenticated: true,
      user: {
        id: session.userId,
        username: session.username,
        role: session.role,
        displayName: session.displayName,
      },
    });
  }
  return res.status(401).json({ success: false, authenticated: false });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  if (token) {
    activeSessions.delete(token);
  }
  return res.json({ success: true, message: 'Logout berhasil. Dashboard terkunci.' });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const session = (req as any).user as UserSession;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Password lama dan baru harus diisi!' });
    }
    const verified = await engineManager.authenticate(session.username, currentPassword);
    if (!verified) {
      return res.status(400).json({ success: false, message: 'Password lama tidak sesuai!' });
    }
    await engineManager.updateUserProfile(session.userId, { password: newPassword });
    if (session.userId === 'admin') {
      await engine.changePassword(newPassword);
    }
    return res.json({ success: true, message: 'Password dashboard berhasil diubah! Simpan password baru Anda.' });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ==========================================
// R&D MULTI-USER PROFILES APIs
// ==========================================
app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const summaries = await engineManager.getUserSummaries();
    return res.json({ success: true, users: summaries });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, displayName, role, initialBalance, cloneFromProfileId, configOverrides } = req.body || {};
    const created = await engineManager.createUserProfile({
      username,
      password,
      displayName,
      role: role || 'USER',
      initialBalance: initialBalance ? parseFloat(String(initialBalance)) : 1000,
      cloneFromProfileId,
      configOverrides,
    });
    return res.json({
      success: true,
      user: {
        id: created.id,
        username: created.username,
        displayName: created.displayName,
        role: created.role,
        status: created.status,
        virtualBalance: created.virtualBalance,
      },
      message: `Profil R&D '${created.displayName}' (@${created.username}) berhasil dibuat dan langsung aktif!`,
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const session = (req as any).user as UserSession;
    if (session.role !== 'ADMIN' && session.userId !== id) {
      return res.status(403).json({ success: false, message: 'Tidak diizinkan mengubah profil user lain.' });
    }
    const { displayName, password, role, status, virtualBalance, config } = req.body || {};
    await engineManager.updateUserProfile(id, {
      displayName,
      password,
      role: session.role === 'ADMIN' ? role : undefined,
      status: session.role === 'ADMIN' ? status : undefined,
      virtualBalance: virtualBalance !== undefined ? parseFloat(String(virtualBalance)) : undefined,
      config,
    });
    return res.json({ success: true, message: `Profil ${id} berhasil diperbarui.` });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await engineManager.deleteUserProfile(id);
    return res.json({ success: true, message: `Profil R&D ${id} berhasil dihapus.` });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/users/current', requireAuth, (req, res) => {
  const session = (req as any).user as UserSession;
  return res.json({ success: true, user: session });
});

// ==========================================
// REST APIs (PROTECTED & STATUS)
// ==========================================
app.get('/api/symbols', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const symbols = await binanceFutures.getTradableSymbols(forceRefresh);
    res.json({ success: true, symbols, cachedAt: Date.now() });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/status', attachAuthIfPresent, (req, res) => {
  const targetEngine = getTargetEngine(req);
  res.json(targetEngine.getStatus());
});

app.get('/api/config', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const targetEngine = getTargetEngine(req);
  await targetEngine.syncConfigFromDb();
  res.json(getSafeConfig(targetEngine.getConfig()));
});

app.post('/api/config', requireAuth, async (req, res) => {
  try {
    const targetEngine = getTargetEngine(req);
    const updated = await targetEngine.saveConfig(req.body);
    res.json({ success: true, config: getSafeConfig(updated) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/start', requireAuth, async (req, res) => {
  const targetEngine = getTargetEngine(req);
  await targetEngine.start();
  res.json({ success: true, status: targetEngine.getStatus() });
});

app.post('/api/stop', requireAuth, (req, res) => {
  const targetEngine = getTargetEngine(req);
  targetEngine.stop();
  res.json({ success: true, status: targetEngine.getStatus() });
});

app.post('/api/reset-demo', requireAuth, (req, res) => {
  const targetEngine = getTargetEngine(req);
  targetEngine.resetDemoWallet();
  res.json({ success: true, status: targetEngine.getStatus() });
});

app.post('/api/close-position', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) {
      return res.status(400).json({ success: false, message: 'Simbol koin harus diisi' });
    }
    const targetEngine = getTargetEngine(req);
    const closed = await targetEngine.manualClosePosition(symbol);
    res.json({ success: closed, status: targetEngine.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/pending-signals/:symbol/cancel', requireAuth, (req, res) => {
  try {
    const { symbol } = req.params;
    const targetEngine = getTargetEngine(req);
    const cancelled = targetEngine.cancelPendingSignal(symbol);
    res.json({ success: cancelled, status: targetEngine.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/pending-signals/:symbol/trigger', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.params;
    const targetEngine = getTargetEngine(req);
    const triggered = await targetEngine.forceTriggerPendingSignal(symbol);
    res.json({ success: triggered, status: targetEngine.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/smart-money/metrics', requireAuth, (req, res) => {
  try {
    const scanner = engine.getSmartMoneyScanner();
    const metrics = scanner ? scanner.getTrackedMetrics() : [];
    res.json({ success: true, metrics });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/smart-money/analyze/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const result = await engine.analyzeSymbol(symbol);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/btc-trend', async (req, res) => {
  try {
    const trend = await engine.updateBtcTrendStatus();
    res.json({ success: true, data: trend });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/check-binance', requireAuth, async (req, res) => {
  try {
    const { apiKey, apiSecret, isTestnet } = req.body || {};
    if (apiKey && apiSecret) {
      binanceFutures.configure(apiKey, apiSecret, !!isTestnet);
    }
    const result = await binanceFutures.testConnection();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/check-telegram', requireAuth, async (req, res) => {
  try {
    const { botToken, chatId } = req.body || {};
    const result = await telegram.testConnection(botToken, chatId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backtest', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    const { symbols, startTime, endTime, bypassCache, ...customParams } = req.body;
    const configSymbols = engine.getConfig()?.scanner?.whitelistSymbols;
    const defaultSymbols = (configSymbols && configSymbols.length > 0) ? configSymbols : ['AKEUSDT', 'CROSSUSDT', 'BTWUSDT'];
    const symbolList = symbols && symbols.length > 0 ? symbols : defaultSymbols;
    const now = Date.now();
    const start = startTime ? new Date(startTime).getTime() : now - 3 * 24 * 60 * 60 * 1000;
    const end = endTime ? new Date(endTime).getTime() : now;

    const result = await backtester.run({
      symbols: symbolList,
      startTime: start,
      endTime: end,
      bypassCache: !!bypassCache,
      ...customParams,
    });
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/backtest/clear-cache', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const deletedCount = dataFetcher.clearAllCache();
    res.json({ success: true, deletedCount, message: `Berhasil membersihkan ${deletedCount} file cache klines.` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// AUTO-TUNER REST APIs (PROTECTED)
// ==========================================
app.get('/api/autotune/status', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const status = engine.getAutoTunerStatus();
    const history = await db.loadTuningLogs(10);
    return res.json({ success: true, status, history });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/autotune/analyze', requireAuth, async (req, res) => {
  try {
    const result = await engine.runAutoTuneAnalysis();
    const status = engine.getAutoTunerStatus();
    return res.json({ ...result, status });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/autotune/apply', requireAuth, async (req, res) => {
  try {
    const { proposalId } = req.body || {};
    const result = await engine.applyTuningProposal(proposalId);
    const status = engine.getAutoTunerStatus();
    return res.json({ ...result, status });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/autotune/rollback', requireAuth, async (req, res) => {
  try {
    const result = await engine.rollbackLastTuning();
    const status = engine.getAutoTunerStatus();
    return res.json({ ...result, status });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});


app.get('/api/logs', (req, res) => {
  res.json(logger.getLogs());
});

app.get('/api/trades', attachAuthIfPresent, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const page = parseInt(String(req.query.page || '1'), 10) || 1;
  const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
  const symbol = req.query.symbol ? String(req.query.symbol).trim() : undefined;
  const outcome = req.query.outcome as 'ALL' | 'WIN' | 'LOSS' | undefined;
  const mode = req.query.mode as 'ALL' | 'LIVE' | 'PAPER' | undefined;
  const strategy = req.query.strategy as 'ALL' | 'SMART_MONEY' | 'WICK_SNIPER' | undefined;

  const targetEngine = getTargetEngine(req);
  const targetUserId = targetEngine.getUserId();

  if (db.isConnected) {
    const result = await db.queryTrades({ page, limit, symbol, outcome, mode, strategy, userId: targetUserId });
    targetEngine.syncTradesFromDb().catch(() => {});
    return res.json({ success: true, ...result });
  }

  // Memory fallback
  let list = targetEngine.getClosedTrades();
  if (symbol) {
    list = list.filter((t) => t.symbol.toUpperCase().includes(symbol.toUpperCase()));
  }
  if (outcome === 'WIN') {
    list = list.filter((t) => t.realizedPnl >= 0);
  } else if (outcome === 'LOSS') {
    list = list.filter((t) => t.realizedPnl < 0);
  }
  if (mode === 'LIVE') {
    list = list.filter((t) => !t.isPaper);
  } else if (mode === 'PAPER') {
    list = list.filter((t) => !!t.isPaper);
  }
  if (strategy === 'SMART_MONEY') {
    list = list.filter((t) => t.strategyType === 'SMART_MONEY' || t.paramsSnapshot?.strategy === 'SMART_MONEY' || !!t.smartMoneyFlowStatus || !!t.paramsSnapshot?.whaleAvgEntry || !!t.paramsSnapshot?.whaleShortRatio || !!t.paramsSnapshot?.whaleLongRatio);
  } else if (strategy === 'WICK_SNIPER') {
    list = list.filter((t) => (t.strategyType !== 'SMART_MONEY' && t.paramsSnapshot?.strategy !== 'SMART_MONEY' && !t.smartMoneyFlowStatus && !t.paramsSnapshot?.whaleAvgEntry && !t.paramsSnapshot?.whaleShortRatio && !t.paramsSnapshot?.whaleLongRatio));
  }

  const total = list.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const offset = (page - 1) * limit;
  const trades = list.slice(offset, offset + limit);

  return res.json({ success: true, trades, total, page, totalPages });
});

app.get('/api/trades/:id/post-exit-30m', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { id } = req.params;
  try {
    let trade = engine.getClosedTrades().find((t) => t.id === id);
    if (!trade && db.isConnected) {
      trade = (await db.getTradeById(id)) || undefined;
    }
    if (!trade) {
      return res.status(404).json({ success: false, message: 'Trade tidak ditemukan' });
    }

    const snapshot = await engine.fetchPostExitSnapshot(trade);
    return res.json({ success: true, snapshot, tradeId: trade.id, symbol: trade.symbol });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/spikes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const page = parseInt(String(req.query.page || '1'), 10) || 1;
  const limit = parseInt(String(req.query.limit || '15'), 10) || 15;
  const symbol = req.query.symbol ? String(req.query.symbol).trim() : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;

  if (db.isConnected) {
    const result = await db.querySpikes({ page, limit, symbol, status });
    return res.json({ success: true, ...result });
  }

  // Memory fallback
  let list = engine.getRecentSpikes();
  if (symbol) {
    list = list.filter((s) => s.symbol.toUpperCase().includes(symbol.toUpperCase()));
  }
  if (status && status !== 'ALL') {
    list = list.filter((s) => s.status === status);
  }

  const total = list.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const offset = (page - 1) * limit;
  const spikes = list.slice(offset, offset + limit);

  const allRecent = engine.getRecentSpikes();
  const simStats = {
    totalSkipped: allRecent.filter((s) => s.status === 'SKIPPED').length,
    savedSlCount: allRecent.filter((s) => s.status === 'SKIPPED' && s.simResult?.outcome === 'SAVED_SL').length,
    missedTpCount: allRecent.filter((s) => s.status === 'SKIPPED' && s.simResult?.outcome === 'MISSED_TP').length,
    trackingCount: allRecent.filter((s) => s.status === 'SKIPPED' && s.simResult?.outcome === 'TRACKING').length,
    timeoutCount: allRecent.filter((s) => s.status === 'SKIPPED' && s.simResult?.outcome === 'TIMEOUT').length,
  };

  return res.json({ success: true, spikes, total, page, totalPages, simStats });
});

// Blacklist management endpoints (protected)
app.get('/api/blacklist', requireAuth, (req, res) => {
  try {
    const list = engine.getScanner().getBlacklist();
    return res.json({ success: true, list });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/blacklist/clear', requireAuth, (req, res) => {
  try {
    engine.getScanner().clearBlacklist();
    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/blacklist/remove', requireAuth, (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, message: 'symbol required' });
    engine.getScanner().removeBlacklist(symbol);
    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/daily-snapshots', attachAuthIfPresent, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
  const mode = req.query.mode as string | undefined;
  const targetEngine = getTargetEngine(req);
  const targetUserId = targetEngine.getUserId();

  if (db.isConnected) {
    const snapshots = await db.getDailySnapshots(limit, mode, targetUserId);
    return res.json({ success: true, snapshots });
  }

  let list = targetEngine.getDailySnapshots();
  if (mode) {
    list = list.filter((s) => s.tradingMode === mode);
  }
  return res.json({ success: true, snapshots: list.slice(0, limit) });
});

app.post('/api/daily-snapshots/trigger', requireAuth, async (req, res) => {
  try {
    const todayWib = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    const targetDate = (req.body?.date as string) || todayWib;
    const snapshot = await engine.takeDailySnapshot(targetDate, false);
    return res.json({ success: true, snapshot, message: `Snapshot untuk tanggal ${targetDate} berhasil diambil.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/ping', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const pingMs = await binanceFutures.measurePing();
  return res.json({ success: true, pingMs });
});

app.get('/api/coin-performance', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const records = await engine.getCoinPerformance();
    return res.json({ success: true, records });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// WebSocket Realtime Broadcaster
wss.on('connection', (ws) => {
  // Kirim initial state & safe config
  ws.send(JSON.stringify({ type: 'STATUS', data: engine.getStatus(), userId: 'admin' }));
  ws.send(JSON.stringify({ type: 'CONFIG', data: getSafeConfig(engine.getConfig()), userId: 'admin' }));
  ws.send(JSON.stringify({ type: 'LOGS', data: logger.getLogs() }));
});

function broadcast(type: string, data: any, userId?: string) {
  const payload = JSON.stringify({ type, data, userId });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

engineManager.onEngineStatus((userId, status) => {
  broadcast('STATUS', status, userId);
});

engineManager.onEngineConfig((userId, config) => {
  broadcast('CONFIG', getSafeConfig(config), userId);
});

logger.onLog((log) => {
  broadcast('LOG', log);
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (engine.getConfig().server?.port || 3005);

server.listen(PORT, HOST, async () => {
  console.log(`\n======================================================`);
  console.log(`🎯 WICK SNIPER BOT - MULTI-USER R&D REVERSAL ENGINE`);
  console.log(`📡 Web Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  // Auto-init multi-user manager & start engines
  await engineManager.init();
  await engine.start();
});
