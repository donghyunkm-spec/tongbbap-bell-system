const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const stores = {
  '3ru': {
    displayClients: new Map(),
    inputClients: new Map(),
    currentNumbers: [],
    currentDisplayMode: 'WAITING',
    name: '3루점',
    soldOutMenus: [],
    currentStatus: '김치말이국수 판매 중입니다',
    currentMsgDisplay: { text: '', duration: 0 }
  },
  '1ru': {
    displayClients: new Map(),
    inputClients: new Map(),
    currentNumbers: [],
    currentDisplayMode: 'WAITING',
    name: '1루점',
    soldOutMenus: [],
    currentStatus: '김치말이국수 판매 중입니다',
    currentMsgDisplay: { text: '', duration: 0 }
  }
};

const PORT = process.env.PORT || 3000;

function addClient(store, clientMap, ws, req) {
  const clientInfo = {
    ws, ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || 'Unknown',
    connectTime: new Date(), lastPing: new Date(),
    isAlive: true, store
  };
  clientMap.set(ws, clientInfo);
  return clientInfo;
}

function removeClient(clientMap, ws) {
  return clientMap.delete(ws);
}

function getClientInfo(ws) {
  for (const storeKey in stores) {
    const store = stores[storeKey];
    if (store.displayClients.has(ws))
      return { client: store.displayClients.get(ws), store: storeKey, type: 'display' };
    if (store.inputClients.has(ws))
      return { client: store.inputClients.get(ws), store: storeKey, type: 'input' };
  }
  return null;
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (e) { return false; }
  }
  return false;
}

// ====== API ======
app.get('/health', (req, res) => {
  const now = new Date();
  const result = {};
  for (const storeKey in stores) {
    const store = stores[storeKey];
    result[store.name] = {
      currentMode: store.currentDisplayMode,
      displays: { count: store.displayClients.size },
      inputs: { count: store.inputClients.size },
      currentNumbers: store.currentNumbers,
      soldOutMenus: store.soldOutMenus,
      currentStatus: store.currentStatus,
      currentMsgDisplay: store.currentMsgDisplay
    };
  }
  res.json({ status: 'ok', timestamp: now.toISOString(), stores: result });
});

app.get('/status', (req, res) => {
  const result = {};
  for (const storeKey in stores) {
    const store = stores[storeKey];
    result[store.name] = {
      currentMode: store.currentDisplayMode,
      displays: store.displayClients.size,
      inputs: store.inputClients.size,
      currentNumbers: store.currentNumbers
    };
  }
  res.json({ server: 'running', uptime: process.uptime(), stores: result, timestamp: new Date().toISOString() });
});

// ====== Heartbeat ======
const HEARTBEAT_INTERVAL = 300000;
const CLIENT_TIMEOUT = 300000;

function heartbeat() {
  for (const storeKey in stores) {
    const store = stores[storeKey];
    const checkClients = (clientMap, label) => {
      const dead = [];
      clientMap.forEach((info, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          if (!info.isAlive) { ws.terminate(); dead.push(ws); }
          else { info.isAlive = false; safeSend(ws, { type: 'PING', timestamp: Date.now() }); }
        } else { dead.push(ws); }
      });
      dead.forEach(ws => removeClient(clientMap, ws));
      return dead.length;
    };
    const deadD = checkClients(store.displayClients, 'Display');
    checkClients(store.inputClients, 'Input');
    if (deadD > 0 && store.displayClients.size === 0)
      notifyInputClients(storeKey, { type: 'DISPLAY_OFF', reason: 'all_disconnected' });
  }
}
const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL);

function cleanupOldConnections() {
  const now = Date.now();
  for (const storeKey in stores) {
    const store = stores[storeKey];
    const cleanup = (clientMap) => {
      const old = [];
      clientMap.forEach((info, ws) => {
        if (now - info.lastPing.getTime() > CLIENT_TIMEOUT) old.push(ws);
      });
      old.forEach(ws => { ws.terminate(); removeClient(clientMap, ws); });
      return old.length;
    };
    const deadD = cleanup(store.displayClients);
    cleanup(store.inputClients);
    if (deadD > 0 && store.displayClients.size === 0)
      notifyInputClients(storeKey, { type: 'DISPLAY_OFF', reason: 'timeout_cleanup' });
  }
}
const cleanupTimer = setInterval(cleanupOldConnections, 5 * 60 * 1000);

// ====== Static & Routes ======
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'input.html')));
app.get('/input.html', (req, res) => res.sendFile(path.join(__dirname, 'input.html')));
app.get('/display.html', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));
app.get('/1ru', (req, res) => res.sendFile(path.join(__dirname, 'input1.html')));
app.get('/input1.html', (req, res) => res.sendFile(path.join(__dirname, 'input1.html')));
app.get('/display1.html', (req, res) => res.sendFile(path.join(__dirname, 'display1.html')));

// ====== 초기 상태 전송 함수 ======
function sendFullState(ws, store) {
  // 1. 모드
  safeSend(ws, { type: 'MODE', mode: store.currentDisplayMode });
  // 2. 호출 목록
  if (store.currentNumbers.length > 0)
    safeSend(ws, { type: 'CALL', list: [...store.currentNumbers] });
  // 3. 품절
  if (store.soldOutMenus.length > 0)
    safeSend(ws, { type: 'MENU_UPDATE', soldOutMenus: [...store.soldOutMenus] });
  // 4. STATUS
  if (store.currentStatus)
    safeSend(ws, { type: 'STATUS', text: store.currentStatus });
  // 5. 전광판 고정문구
  if (store.currentMsgDisplay.text && store.currentMsgDisplay.text.trim())
    safeSend(ws, { type: 'MSG_DISPLAY', text: store.currentMsgDisplay.text, duration: store.currentMsgDisplay.duration });
}

// ====== WebSocket ======
wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;

  ws.on('message', (data) => {
    const message = data.toString();

    // PONG
    if (message.startsWith('{')) {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'PONG') {
          const ci = getClientInfo(ws);
          if (ci) { ci.client.isAlive = true; ci.client.lastPing = new Date(); }
          return;
        }
      } catch (e) { }
    }

    // DISPLAY 등록
    if (message === 'DISPLAY' || message.startsWith('DISPLAY:')) {
      const storeKey = message === 'DISPLAY:1ru' ? '1ru' : '3ru';
      const store = stores[storeKey];
      addClient(storeKey, store.displayClients, ws, req);
      console.log(`📺 ${store.name} 디스플레이 등록 (총 ${store.displayClients.size}개)`);

      notifyInputClients(storeKey, { type: 'DISPLAY_ON', count: store.displayClients.size });
      sendFullState(ws, store);
      return;
    }

    // INPUT 등록
    if (message === 'INPUT' || message.startsWith('INPUT:')) {
      const storeKey = message === 'INPUT:1ru' ? '1ru' : '3ru';
      const store = stores[storeKey];
      addClient(storeKey, store.inputClients, ws, req);
      console.log(`📱 ${store.name} 입력 등록 (총 ${store.inputClients.size}개)`);

      sendFullState(ws, store);
      // TV 연결 상태
      if (store.displayClients.size > 0)
        safeSend(ws, { type: 'DISPLAY_ON', count: store.displayClients.size });
      else
        safeSend(ws, { type: 'DISPLAY_OFF', reason: 'no_displays' });
      return;
    }

    // 일반 메시지
    const ci = getClientInfo(ws);
    if (ci) {
      ci.client.isAlive = true;
      ci.client.lastPing = new Date();
      processMessage(ci.store, message, clientIP);
    }
  });

  ws.on('close', () => {
    const ci = getClientInfo(ws);
    if (ci) {
      const store = stores[ci.store];
      const wasDisplay = removeClient(store.displayClients, ws);
      removeClient(store.inputClients, ws);
      if (wasDisplay && store.displayClients.size === 0)
        notifyInputClients(ci.store, { type: 'DISPLAY_OFF', reason: 'disconnected' });
    }
  });

  ws.on('error', () => {
    for (const k in stores) {
      removeClient(stores[k].displayClients, ws);
      removeClient(stores[k].inputClients, ws);
    }
  });
});

// ====== 메시지 처리 ======
function processMessage(storeKey, message, clientIP) {
  const store = stores[storeKey];
  let responseData = null;
  let broadcastTarget = 'display'; // 'display' | 'all' | 'none'

  if (message.startsWith('MODE:')) {
    const mode = message.substring(5);
    if (mode === 'WAITING' || mode === 'CALL') {
      store.currentDisplayMode = mode;
      responseData = { type: 'MODE', mode };
      broadcastTarget = 'all';
      console.log(`🔄 ${store.name} 모드 변경: ${mode}`);

      // 호출 모드로 변경될 때 데이터 재전송
      if (mode === 'CALL') {
        setTimeout(() => {
          // 1. 번호 목록 전송
          if (store.currentNumbers.length > 0) {
            broadcastToDisplays(storeKey, JSON.stringify({ type: 'CALL', list: [...store.currentNumbers] }));
          }
          // 2. 현재 상태(판매중 문구) 재전송 (추가된 부분)
          if (store.currentStatus) {
            broadcastToDisplays(storeKey, JSON.stringify({ type: 'STATUS', text: store.currentStatus }));
          }
        }, 150); // 화면이 바뀔 시간을 주기 위해 약간의 지연 후 전송
      }
    }
  } else if (message.startsWith('CALL:')) {
    const number = parseInt(message.split(':')[1]);
    if (!isNaN(number)) {
      const idx = store.currentNumbers.indexOf(number);
      if (idx !== -1) store.currentNumbers.splice(idx, 1);
      store.currentNumbers.push(number);
      if (store.currentNumbers.length > 10) store.currentNumbers.shift();

      responseData = { type: 'CALL', list: [...store.currentNumbers], calledNumber: number };
      broadcastTarget = 'all';
      console.log(`📢 ${store.name} 호출: ${number} - [${store.currentNumbers.join(', ')}]`);
    }

  } else if (message === 'CALL_LAST') {
    if (store.currentNumbers.length > 0) {
      const last = store.currentNumbers[store.currentNumbers.length - 1];
      responseData = { type: 'CALL', list: [...store.currentNumbers], calledNumber: last };
      broadcastTarget = 'all';
    }

  } else if (message.startsWith('CALL_PLUS_ONE:')) {
    const number = parseInt(message.split(':')[1]);
    if (!isNaN(number)) {
      const idx = store.currentNumbers.indexOf(number);
      if (idx !== -1) store.currentNumbers.splice(idx, 1);
      store.currentNumbers.push(number);
      if (store.currentNumbers.length > 10) store.currentNumbers.shift();
      responseData = { type: 'CALL', list: [...store.currentNumbers], calledNumber: number };
      broadcastTarget = 'all';
    }

  } else if (message.startsWith('SEQUENCE_NEW:')) {
    const nums = message.substring(13).split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    if (nums.length > 0) {
      store.currentNumbers = nums.slice(0, 10);
      responseData = { type: 'CALL', list: [...store.currentNumbers], calledNumber: store.currentNumbers[store.currentNumbers.length - 1], calledNumbers: [...store.currentNumbers] };
      broadcastTarget = 'all';
    }

  } else if (message.startsWith('SEQUENCE:')) {
    const nums = message.substring(9).split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    if (nums.length > 0) {
      store.currentNumbers = nums.slice(0, 10);
      responseData = { type: 'CALL', list: [...store.currentNumbers], calledNumber: store.currentNumbers[store.currentNumbers.length - 1] };
      broadcastTarget = 'all';
    }

  } else if (message.startsWith('STATUS:')) {
    const text = message.substring(7);
    store.currentStatus = text;
    responseData = { type: 'STATUS', text };
    broadcastTarget = 'all';
    console.log(`📊 ${store.name} 상태: "${text}"`);

  } else if (message.startsWith('AUDIO:')) {
    responseData = { type: 'AUDIO', audioType: message.substring(6) };
    broadcastTarget = 'display';

  } else if (message.startsWith('MSG:')) {
    const text = message.substring(4);
    if (storeKey === '1ru') {
      const match = text.match(/(\d+)번 손님까지 드립니다/);
      if (match) {
        const num = parseInt(match[1]);
        if (!store.currentNumbers.includes(num)) {
          store.currentNumbers.push(num);
          if (store.currentNumbers.length > 10) store.currentNumbers.shift();
        }
        responseData = { type: 'SERVE_UNTIL', text, number: num, currentNumbers: [...store.currentNumbers] };
      } else {
        responseData = { type: 'MSG', text };
      }
    } else {
      responseData = { type: 'MSG', text };
    }
    broadcastTarget = 'all';
    console.log(`💬 ${store.name} 메시지: "${text}"`);

  } else if (message.startsWith('TIME:') && storeKey === '1ru') {
    const parts = message.split(':');
    if (parts.length >= 3) {
      const sam = parseInt(parts[1]), noodle = parseInt(parts[2]);
      if (!isNaN(sam) && !isNaN(noodle)) {
        responseData = { type: 'TIME', sam, noodle };
        broadcastTarget = 'display';
      }
    }

  } else if (message === 'CLEAR') {
    store.currentNumbers = [];
    responseData = { type: 'CALL', list: [] };
    broadcastTarget = 'all';
    console.log(`🧹 ${store.name} 초기화`);

  } else if (message.startsWith('TOGGLE_MENU:')) {
    const menuName = message.substring(12);
    if (menuName) {
      const idx = store.soldOutMenus.indexOf(menuName);
      if (idx === -1) store.soldOutMenus.push(menuName);
      else store.soldOutMenus.splice(idx, 1);
      responseData = { type: 'MENU_UPDATE', soldOutMenus: [...store.soldOutMenus] };
      broadcastTarget = 'all';
      console.log(`🚫 ${store.name} 품절: ${menuName} (현재: ${store.soldOutMenus.join(', ')})`);
    }

  } else if (message.startsWith('MSG_DISPLAY:')) {
    const parts = message.substring(12).split('|');
    const text = parts[0].trim();
    const duration = parts.length > 1 ? parseInt(parts[1]) : 10000;

    store.currentMsgDisplay = (text && text.trim()) ? { text, duration } : { text: '', duration: 0 };
    responseData = { type: 'MSG_DISPLAY', text, duration };
    broadcastTarget = 'all';
    console.log(`📝 ${store.name} 전광판: "${text}" (${duration}ms)`);
  }

  // 브로드캐스트
  if (responseData) {
    const msg = JSON.stringify(responseData);
    broadcastToDisplays(storeKey, msg);
    if (broadcastTarget === 'all') {
      notifyInputClients(storeKey, responseData);
    }
  }
}

function broadcastToDisplays(storeKey, message) {
  const store = stores[storeKey];
  const dead = [];
  store.displayClients.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(message); } catch (e) { dead.push(ws); }
    } else { dead.push(ws); }
  });
  dead.forEach(ws => removeClient(store.displayClients, ws));
}

function notifyInputClients(storeKey, data) {
  const store = stores[storeKey];
  const msg = JSON.stringify(data);
  const dead = [];
  store.inputClients.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (e) { dead.push(ws); }
    } else { dead.push(ws); }
  });
  dead.forEach(ws => removeClient(store.inputClients, ws));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 통빱 다중 매장 호출벨 시스템 시작!`);
  console.log(`📱 3루점: http://localhost:${PORT}/input.html | 🖥️ http://localhost:${PORT}/display.html`);
  console.log(`📱 1루점: http://localhost:${PORT}/input1.html | 🖥️ http://localhost:${PORT}/display1.html`);
  console.log(`📊 상태: http://localhost:${PORT}/health`);

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} - 종료 시작`);
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    const msg = JSON.stringify({ type: 'SERVER_SHUTDOWN', message: '서버가 곧 종료됩니다' });
    for (const k in stores) {
      const store = stores[k];
      [...store.displayClients.keys(), ...store.inputClients.keys()].forEach(ws => {
        try { ws.send(msg); ws.close(1001); } catch (e) { }
      });
    }
    wss.close(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000);
  }
});