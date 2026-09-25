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

import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const engine = new WickSniperEngine(CONFIG_PATH);

// Sesi Token Login (Token -> Expiry Timestamp)
const activeSessions = new Map<string, number>();
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // Sesi aktif selama 7 hari

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function isValidToken(token?: string | null): boolean {
  if (!token) return false;
  const expiresAt = activeSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
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
  if (isValidToken(token)) {
    return next();
  }
  return res.status(401).json({
    success: false,
    message: 'Akses ditolak: Harap masukkan password login dashboard terlebih dahulu.',
  });
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
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !engine.verifyPassword(password)) {
    logger.log('WARN', '⚠️ Percobaan login dashboard dengan password salah.');
    return res.status(401).json({ success: false, message: 'Password salah! Periksa kembali password Anda.' });
  }

  const token = generateToken();
  activeSessions.set(token, Date.now() + SESSION_DURATION_MS);
  logger.log('SUCCESS', '🔓 Login dashboard berhasil. Sesi otentikasi aktif.');
  return res.json({
    success: true,
    token,
    message: 'Login berhasil! Selamat datang di Wick Sniper Terminal.',
  });
});

app.get('/api/auth/check', (req, res) => {
  const token = extractToken(req);
  if (isValidToken(token)) {
    return res.json({ success: true, authenticated: true });
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
    if (!currentPassword || !engine.verifyPassword(currentPassword)) {
      return res.status(400).json({ success: false, message: 'Password lama tidak sesuai!' });
    }
    await engine.changePassword(newPassword);
    return res.json({ success: true, message: 'Password dashboard berhasil diubah! Simpan password baru Anda.' });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ==========================================
// REST APIs (PROTECTED & STATUS)
// ==========================================
app.get('/api/status', (req, res) => {
  res.json(engine.getStatus());
});

app.get('/api/config', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  await engine.syncConfigFromDb();
  res.json(getSafeConfig(engine.getConfig()));
});

app.post('/api/config', requireAuth, async (req, res) => {
  try {
    const updated = await engine.saveConfig(req.body);
    res.json({ success: true, config: getSafeConfig(updated) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/start', requireAuth, async (req, res) => {
  await engine.start();
  res.json({ success: true, status: engine.getStatus() });
});

app.post('/api/stop', requireAuth, (req, res) => {
  engine.stop();
  res.json({ success: true, status: engine.getStatus() });
});

app.post('/api/reset-demo', requireAuth, (req, res) => {
  engine.resetDemoWallet();
  res.json({ success: true, status: engine.getStatus() });
});

app.post('/api/close-position', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) {
      return res.status(400).json({ success: false, message: 'Simbol koin harus diisi' });
    }
    const closed = await engine.manualClosePosition(symbol);
    res.json({ success: closed, status: engine.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
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

app.get('/api/logs', (req, res) => {
  res.json(logger.getLogs());
});

// WebSocket Realtime Broadcaster
wss.on('connection', (ws) => {
  // Kirim initial state & safe config
  ws.send(JSON.stringify({ type: 'STATUS', data: engine.getStatus() }));
  ws.send(JSON.stringify({ type: 'CONFIG', data: getSafeConfig(engine.getConfig()) }));
  ws.send(JSON.stringify({ type: 'LOGS', data: logger.getLogs() }));
});

function broadcast(type: string, data: any) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

engine.onStatus((status) => {
  broadcast('STATUS', status);
});

engine.onConfig((config) => {
  broadcast('CONFIG', getSafeConfig(config));
});

logger.onLog((log) => {
  broadcast('LOG', log);
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (engine.getConfig().server?.port || 3005);

server.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🎯 WICK SNIPER BOT - HIGH-FREQUENCY REVERSAL ENGINE`);
  console.log(`📡 Web Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  // Auto-start engine
  await engine.start();
});
