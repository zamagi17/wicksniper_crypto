import { binanceFutures } from './src/services/binance';

async function main() {
  const http = await binanceFutures.getHttpClient();
  const res = await http.get('/fapi/v1/klines', {
    params: { symbol: 'AKEUSDT', interval: '1m', limit: 5 }
  });
  console.log('KLINES OK! Count:', res.data.length);
  for (const c of res.data) {
    const time = new Date(c[0]).toLocaleTimeString('id-ID');
    console.log(`[${time}] Open: ${c[1]} | High: ${c[2]} | Low: ${c[3]} | Close: ${c[4]} | Vol: ${c[5]}`);
  }
}

main().catch(err => console.error('ERR:', err.message));
