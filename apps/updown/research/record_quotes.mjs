// Public market-data collection only. Stops after --hours (24 by default).
// No wallet, env files, authorization, order submission or app-worker changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const hoursArg = process.argv.indexOf('--hours');
const hours = hoursArg < 0 ? 24 : Number(process.argv[hoursArg + 1]);
if (!(hours > 0 && hours <= 168)) throw new Error('Choose --hours between 0 and 168.');
const startedAt = Date.now(), stopAt = startedAt + hours * 3600000;
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results', `quotes-${startedAt}`);
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'quotes.jsonl');
const metadataFile = path.join(directory, 'status.json');
// Same anonymous public-stream ID used by the installed Orderly SDK.
const endpoint = 'wss://ws-evm.orderly.org/ws/stream/OqdphuyCtYWxwzhxyLLjOWNdFP7sQt8RPWzmb5xY';
const symbols = ['PERP_SOL_USDC', 'PERP_BTC_USDC', 'PERP_ETH_USDC'];
let socket, stopped = false, retryTimer, lastMessage = Date.now(), rows = 0;
const counts = Object.fromEntries(symbols.map(s => [s, 0]));
const lastBySymbol = {};
const status = { pid: process.pid, startedAt, stopAt, endpoint, symbols, file, state: 'connecting' };
function saveStatus() {
  fs.writeFileSync(metadataFile + '.tmp', JSON.stringify({ ...status, updatedAt: Date.now(), rows, counts, lastBySymbol }, null, 2));
  fs.renameSync(metadataFile + '.tmp', metadataFile);
}
function finish() {
  if (stopped) return;
  stopped = true; clearInterval(watchdog); clearTimeout(retryTimer); clearTimeout(deadline);
  socket?.terminate(); status.state = 'finished'; saveStatus();
  console.log(`Finished collecting ${rows} public quotes. ${directory}`);
}
function connect() {
  if (stopped) return;
  status.state = 'connecting'; lastMessage = Date.now(); saveStatus();
  socket = new WebSocket(endpoint, { handshakeTimeout: 15000 });
  socket.on('open', () => {
    status.state = 'recording'; saveStatus();
    for (const symbol of symbols) socket.send(JSON.stringify({ id: symbol, event: 'subscribe', topic: `${symbol}@orderbook` }));
  });
  socket.on('message', bytes => {
    lastMessage = Date.now();
    const message = JSON.parse(bytes.toString());
    if (message.event === 'ping') { socket.send(JSON.stringify({ event: 'pong', ts: message.ts })); return; }
    if (message.success === false) { status.lastError = message.errorMsg || message.message || 'Subscription rejected'; saveStatus(); return; }
    const book = message.data;
    const symbol = book?.symbol || message.topic?.split('@')[0];
    if (!symbols.includes(symbol) || !Array.isArray(book?.bids) || !Array.isArray(book?.asks)) return;
    const bids = book.bids.filter(p => Number(p[1]) > 0).sort((a, b) => b[0] - a[0]);
    const asks = book.asks.filter(p => Number(p[1]) > 0).sort((a, b) => a[0] - b[0]);
    const bid = Number(bids[0]?.[0]), ask = Number(asks[0]?.[0]), ts = Number(message.ts);
    if (!(Number.isFinite(ts) && bid > 0 && ask >= bid) || ts <= (lastBySymbol[symbol] || 0)) return;
    // Retain public top-of-book prices and sizes, not addresses or account data.
    fs.appendFileSync(file, JSON.stringify({ symbol, ts, receivedAt: Date.now(), bid, ask, bidSize: Number(bids[0][1]), askSize: Number(asks[0][1]) }) + '\n');
    lastBySymbol[symbol] = ts; rows++; counts[symbol]++;
  });
  socket.on('error', error => { status.lastError = error.message; saveStatus(); });
  socket.on('close', () => {
    if (stopped) return;
    status.state = 'reconnecting'; saveStatus(); retryTimer = setTimeout(connect, 5000);
  });
}
const watchdog = setInterval(() => {
  if (Date.now() - lastMessage > 30000) socket?.terminate();
  saveStatus();
}, 10000);
const deadline = setTimeout(finish, Math.max(1, stopAt - Date.now()));
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
connect();
console.log(`Recording public quotes for ${hours} hours into ${directory}`);
