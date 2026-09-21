import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { WickSniperEngine } from './services/engine';
import { logger } from './services/logger';
import { backtester } from './services/backtester';
import { binanceFutures } from './services/binance';
import { telegram } from './services/telegram';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const engine = new WickSniperEngine(CONFIG_PATH);

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

// REST APIs
app.get('/api/status', (req, res) => {
  res.json(engine.getStatus());
});

app.get('/api/config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  await engine.syncConfigFromDb();
  res.json(engine.getConfig());
});

app.post('/api/config', async (req, res) => {
  try {
    const updated = await engine.saveConfig(req.body);
    res.json({ success: true, config: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/start', async (req, res) => {
  await engine.start();
  res.json({ success: true, status: engine.getStatus() });
});

app.post('/api/stop', (req, res) => {
  engine.stop();
  res.json({ success: true, status: engine.getStatus() });
});

app.post('/api/reset-demo', (req, res) => {
  engine.resetDemoWallet();
  res.json({ success: true, status: engine.getStatus() });
});

app.post('/api/close-position', async (req, res) => {
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

app.post('/api/check-binance', async (req, res) => {
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

app.post('/api/check-telegram', async (req, res) => {
  try {
    const { botToken, chatId } = req.body || {};
    const result = await telegram.testConnection(botToken, chatId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backtest', async (req, res) => {
  try {
    const { symbols, startTime, endTime, ...customParams } = req.body;
    const symbolList = symbols && symbols.length > 0 ? symbols : ['AKEUSDT', 'CROSSUSDT', 'BTWUSDT'];
    const now = Date.now();
    const start = startTime ? new Date(startTime).getTime() : now - 3 * 24 * 60 * 60 * 1000;
    const end = endTime ? new Date(endTime).getTime() : now;

    const result = await backtester.run({
      symbols: symbolList,
      startTime: start,
      endTime: end,
      ...customParams,
    });
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  res.json(logger.getLogs());
});

// WebSocket Realtime Broadcaster
wss.on('connection', (ws) => {
  // Kirim initial state & config
  ws.send(JSON.stringify({ type: 'STATUS', data: engine.getStatus() }));
  ws.send(JSON.stringify({ type: 'CONFIG', data: engine.getConfig() }));
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
  broadcast('CONFIG', config);
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
