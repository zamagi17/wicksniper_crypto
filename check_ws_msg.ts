import WebSocket from 'ws';
import https from 'https';

const agent = new https.Agent({
  lookup: (h, o, cb: any) => cb(null, '35.77.171.26', 4)
});

const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr', { agent });
ws.on('open', () => console.log('OPEN!'));
ws.on('message', (m) => {
  const str = m.toString();
  console.log('RAW SLICE:', str.slice(0, 150));
  const parsed = JSON.parse(str);
  console.log('Is Array?', Array.isArray(parsed));
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => console.error('ERR:', e.message));
