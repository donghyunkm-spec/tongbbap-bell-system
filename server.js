const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 매장별 데이터 분리
const stores = {
  '3ru': {
    displayClients: new Map(),
    inputClients: new Map(),
    currentNumbers: [],
    currentDisplayMode: 'WAITING',
    name: '3루점'
  },
  '1ru': {
    displayClients: new Map(),
    inputClients: new Map(),
    currentNumbers: [],
    currentDisplayMode: 'WAITING',
    name: '1루점'
  }
};

const PORT = process.env.PORT || 3000;

function addClient(store, clientMap, ws, req) {
  const clientInfo = {
    ws: ws,
    ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || 'Unknown',
    connectTime: new Date(),
    lastPing: new Date(),
    isAlive: true,
    store: store
  };
  clientMap.set(ws, clientInfo);
  return clientInfo;
}

function removeClient(clientMap, ws) {
  return clientMap.delete(ws);
}

function getClientInfo(ws) {
  // 모든 매장에서 클라이언트 찾기
  for (const storeKey in stores) {
    const store = stores[storeKey];
    if (store.displayClients.has(ws)) {
      return { client: store.displayClients.get(ws), store: storeKey, type: 'display' };
    }
    if (store.inputClients.has(ws)) {
      return { client: store.inputClients.get(ws), store: storeKey, type: 'input' };
    }
  }
  return null;
}

app.get('/health', (req, res) => {
  const now = new Date();
  const result = {};
  
  for (const storeKey in stores) {
    const store = stores[storeKey];
    const displayStats = Array.from(store.displayClients.values()).map(client => ({
      ip: client.ip,
      connected: Math.floor((now - client.connectTime) / 1000) + 's',
      lastPing: Math.floor((now - client.lastPing) / 1000) + 's ago',
      alive: client.isAlive
    }));
    
    const inputStats = Array.from(store.inputClients.values()).map(client => ({
      ip: client.ip,
      connected: Math.floor((now - client.connectTime) / 1000) + 's',
      lastPing: Math.floor((now - client.lastPing) / 1000) + 's ago',
      alive: client.isAlive
    }));

    result[store.name] = {
      currentMode: store.currentDisplayMode,
      displays: {
        count: store.displayClients.size,
        clients: displayStats
      },
      inputs: {
        count: store.inputClients.size,
        clients: inputStats
      },
      currentNumbers: store.currentNumbers
    };
  }

  res.json({ 
    status: 'ok',
    timestamp: now.toISOString(),
    stores: result
  });
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

  res.json({
    server: 'running',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    stores: result,
    timestamp: new Date().toISOString()
  });
});

const HEARTBEAT_INTERVAL = 300000;
const CLIENT_TIMEOUT = 300000;

function heartbeat() {
  console.log(`💓 하트비트 체크 시작`);
  
  for (const storeKey in stores) {
    const store = stores[storeKey];
    console.log(`   ${store.name} - Display: ${store.displayClients.size}, Input: ${store.inputClients.size}`);
    
    const deadDisplays = [];
    store.displayClients.forEach((clientInfo, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (clientInfo.isAlive === false) {
          console.log(`💀 ${store.name} Display 응답 없음 (${clientInfo.ip})`);
          ws.terminate();
          deadDisplays.push(ws);
        } else {
          clientInfo.isAlive = false;
          try {
            ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
          } catch (error) {
            console.error(`❌ ${store.name} Display PING 실패:`, error.message);
            deadDisplays.push(ws);
          }
        }
      } else {
        deadDisplays.push(ws);
      }
    });

    const deadInputs = [];
    store.inputClients.forEach((clientInfo, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (clientInfo.isAlive === false) {
          console.log(`💀 ${store.name} Input 응답 없음 (${clientInfo.ip})`);
          ws.terminate();
          deadInputs.push(ws);
        } else {
          clientInfo.isAlive = false;
          try {
            ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
          } catch (error) {
            console.error(`❌ ${store.name} Input PING 실패:`, error.message);
            deadInputs.push(ws);
          }
        }
      } else {
        deadInputs.push(ws);
      }
    });

    deadDisplays.forEach(ws => removeClient(store.displayClients, ws));
    deadInputs.forEach(ws => removeClient(store.inputClients, ws));

    if (deadDisplays.length > 0) {
      console.log(`📺 ${store.name} 디스플레이 ${deadDisplays.length}개 정리됨`);
      if (store.displayClients.size === 0) {
        notifyInputClients(storeKey, { type: 'DISPLAY_OFF', reason: 'all_disconnected' });
      }
    }
  }
}

const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL);

function cleanupOldConnections() {
  const now = Date.now();
  
  for (const storeKey in stores) {
    const store = stores[storeKey];
    const oldDisplays = [];
    const oldInputs = [];

    store.displayClients.forEach((clientInfo, ws) => {
      if (now - clientInfo.lastPing.getTime() > CLIENT_TIMEOUT) {
        oldDisplays.push(ws);
      }
    });

    store.inputClients.forEach((clientInfo, ws) => {
      if (now - clientInfo.lastPing.getTime() > CLIENT_TIMEOUT) {
        oldInputs.push(ws);
      }
    });

    oldDisplays.forEach(ws => {
      ws.terminate();
      removeClient(store.displayClients, ws);
    });

    oldInputs.forEach(ws => {
      ws.terminate();
      removeClient(store.inputClients, ws);
    });

    if (oldDisplays.length > 0 && store.displayClients.size === 0) {
      notifyInputClients(storeKey, { type: 'DISPLAY_OFF', reason: 'timeout_cleanup' });
    }
  }
}

const cleanupTimer = setInterval(cleanupOldConnections, 5 * 60 * 1000);

// 정적 파일 제공
app.use(express.static(__dirname));

// === 라우팅 설정 ===
// 3루점 시스템
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'input.html'));
});

app.get('/input.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'input.html'));
});

app.get('/display.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'display.html'));
});

// 1루점 시스템  
app.get('/1ru', (req, res) => {
  res.sendFile(path.join(__dirname, 'input1.html'));
});

app.get('/input1.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'input1.html'));
});

app.get('/display1.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'display1.html'));
});

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  console.log(`🔗 새 클라이언트 연결: ${clientIP}`);

  ws.on('message', (data) => {
    const message = data.toString();
    console.log(`📩 받은 메시지 (${clientIP}):`, message);

    // PONG 응답 처리
    if (message.startsWith('{') && message.includes('PONG')) {
      try {
        const pongData = JSON.parse(message);
        if (pongData.type === 'PONG') {
          const clientInfo = getClientInfo(ws);
          if (clientInfo && clientInfo.client) {
            clientInfo.client.isAlive = true;
            clientInfo.client.lastPing = new Date();
            console.log(`🏓 ${stores[clientInfo.store].name} PONG 받음 (${clientIP})`);
          }
          return;
        }
      } catch (e) {}
    }

    // 매장 구분해서 디스플레이/입력 클라이언트 등록
    if (message === 'DISPLAY' || message === 'DISPLAY:3ru' || message === 'DISPLAY:1ru') {
      let storeKey = '3ru'; // 기본값
      
      if (message === 'DISPLAY:1ru') {
        storeKey = '1ru';
      } else if (message === 'DISPLAY:3ru') {
        storeKey = '3ru';
      }
      
      const store = stores[storeKey];
      const clientInfo = addClient(storeKey, store.displayClients, ws, req);
      console.log(`📺 ${store.name} 디스플레이 등록: ${clientIP} (총 ${store.displayClients.size}개)`);
      
      notifyInputClients(storeKey, { 
        type: 'DISPLAY_ON', 
        count: store.displayClients.size,
        timestamp: new Date().toISOString()
      });
      
      try {
        ws.send(JSON.stringify({
          type: 'MODE',
          mode: store.currentDisplayMode,
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        console.error(`❌ ${store.name} 모드 전송 실패:`, error.message);
      }
      
      if (store.currentDisplayMode === 'CALL' && store.currentNumbers.length > 0) {
        try {
          ws.send(JSON.stringify({
            type: 'CALL',
            list: [...store.currentNumbers],
            timestamp: new Date().toISOString()
          }));
        } catch (error) {
          console.error(`❌ ${store.name} 번호 전송 실패:`, error.message);
        }
      }
      
    } else if (message === 'INPUT' || message === 'INPUT:3ru' || message === 'INPUT:1ru') {
      let storeKey = '3ru'; // 기본값
      
      if (message === 'INPUT:1ru') {
        storeKey = '1ru';
      } else if (message === 'INPUT:3ru') {
        storeKey = '3ru';
      }
      
      const store = stores[storeKey];
      const clientInfo = addClient(storeKey, store.inputClients, ws, req);
      console.log(`📱 ${store.name} 입력 클라이언트 등록: ${clientIP} (총 ${store.inputClients.size}개)`);
      
      try {
        if (store.displayClients.size > 0) {
          ws.send(JSON.stringify({ 
            type: 'DISPLAY_ON', 
            count: store.displayClients.size,
            timestamp: new Date().toISOString()
          }));
        } else {
          ws.send(JSON.stringify({ 
            type: 'DISPLAY_OFF', 
            reason: 'no_displays',
            timestamp: new Date().toISOString()
          }));
        }
        
        if (store.currentNumbers.length > 0) {
          ws.send(JSON.stringify({ 
            type: 'CALL', 
            list: [...store.currentNumbers],
            timestamp: new Date().toISOString()
          }));
        }
      } catch (error) {
        console.error(`❌ ${store.name} 입력 상태 전송 실패:`, error.message);
      }
      
    } else {
      // 메시지 처리 시 클라이언트가 어느 매장인지 확인
      const clientInfo = getClientInfo(ws);
      if (clientInfo) {
        processMessage(clientInfo.store, message, clientIP);
      }
    }
  });

  ws.on('close', (code, reason) => {
    const clientInfo = getClientInfo(ws);
    if (clientInfo) {
      const store = stores[clientInfo.store];
      const wasDisplay = removeClient(store.displayClients, ws);
      const wasInput = removeClient(store.inputClients, ws);
      
      console.log(`❌ ${store.name} 클라이언트 해제: ${clientIP}`);
      
      if (wasDisplay) {
        console.log(`📺 ${store.name} 디스플레이 해제 - 남은 개수: ${store.displayClients.size}`);
        if (store.displayClients.size === 0) {
          notifyInputClients(clientInfo.store, { 
            type: 'DISPLAY_OFF', 
            reason: 'disconnected',
            timestamp: new Date().toISOString()
          });
        }
      }
      
      if (wasInput) {
        console.log(`📱 ${store.name} 입력 클라이언트 해제 - 남은 개수: ${store.inputClients.size}`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`⚠️ WebSocket 에러 (${clientIP}):`, err.message);
    // 에러 시 모든 매장에서 클라이언트 제거
    for (const storeKey in stores) {
      const store = stores[storeKey];
      removeClient(store.displayClients, ws);
      removeClient(store.inputClients, ws);
    }
  });

  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
      } catch (error) {
        console.error(`❌ 초기 PING 실패 (${clientIP}):`, error.message);
      }
    }
  }, 1000);
});

function processMessage(storeKey, message, clientIP) {
  const store = stores[storeKey];
  let responseData = null;

  if (message.startsWith('MODE:')) {
    const mode = message.substring(5);
    if (mode === 'WAITING' || mode === 'CALL') {
      store.currentDisplayMode = mode;
      responseData = {
        type: 'MODE',
        mode: mode,
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`🔄 ${store.name} 모드 변경: ${mode} (${clientIP})`);
      
      if (mode === 'CALL' && store.currentNumbers.length > 0) {
        setTimeout(() => {
          const callData = {
            type: 'CALL',
            list: [...store.currentNumbers],
            timestamp: new Date().toISOString()
          };
          broadcastToDisplays(storeKey, JSON.stringify(callData));
        }, 100);
      }
    }
  } else if (message.startsWith('CALL:')) {
    const number = parseInt(message.split(':')[1]);
    if (!isNaN(number)) {
      // 모든 매장에 기존 번호 재호출 시 순서 변경 로직 적용
      const existingIndex = store.currentNumbers.indexOf(number);
      if (existingIndex !== -1) {
        // 기존 번호를 제거하고 맨 뒤에 추가
        store.currentNumbers.splice(existingIndex, 1);
        store.currentNumbers.push(number);
      } else {
        // 새 번호 추가
        store.currentNumbers.push(number);
        // 3루점은 최대 5개, 1루점은 최대 10개
        const maxNumbers = storeKey === '3ru' ? 5 : 10;
        if (store.currentNumbers.length > maxNumbers) {
          store.currentNumbers.shift();
        }
      }
      
      responseData = {
        type: 'CALL',
        list: [...store.currentNumbers],
        calledNumber: number,
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`📢 ${store.name} 호출: ${number} (${clientIP}) - 목록: [${store.currentNumbers.join(', ')}]`);
    }
  } else if (message.startsWith('CALL_PLUS_ONE:')) {
    // 호출+1 기능 (모든 매장)
    const number = parseInt(message.split(':')[1]);
    if (!isNaN(number)) {
      store.currentNumbers.push(number);
      const maxNumbers = storeKey === '3ru' ? 5 : 10;
      if (store.currentNumbers.length > maxNumbers) {
        store.currentNumbers.shift();
      }
      
      responseData = {
        type: 'CALL',
        list: [...store.currentNumbers],
        calledNumber: number,
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`📢 ${store.name} 호출+1: ${number} (${clientIP}) - 목록: [${store.currentNumbers.join(', ')}]`);
    }
  } else if (message.startsWith('CALL_LAST')) {
    // 빈 칸으로 호출 버튼 눌렀을 때 마지막 번호 호출
    if (store.currentNumbers.length > 0) {
      const lastNumber = store.currentNumbers[store.currentNumbers.length - 1];
      
      responseData = {
        type: 'CALL',
        list: [...store.currentNumbers],
        calledNumber: lastNumber,
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`📢 ${store.name} 마지막 번호 재호출: ${lastNumber} (${clientIP}) - 목록: [${store.currentNumbers.join(', ')}]`);
    }
  } else if (message.startsWith('SEQUENCE_NEW:')) {
    // 새로운 연속 호출 로직 (모든 매장)
	  const numbersStr = message.substring(13);
	  const newNumbers = numbersStr.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
	  
	  if (newNumbers.length > 0) {
		const maxNumbers = storeKey === '3ru' ? 5 : 10;
		store.currentNumbers = newNumbers.slice(0, maxNumbers);
		const lastNumber = store.currentNumbers[store.currentNumbers.length - 1];
		
		responseData = {
		  type: 'CALL',
		  list: [...store.currentNumbers],
		  calledNumber: lastNumber,
		  calledNumbers: [...store.currentNumbers], // 🔥 이 줄 추가
		  timestamp: new Date().toISOString(),
		  triggeredBy: clientIP
		};
		
		console.log(`📢 ${store.name} 새로운 연속 호출: [${newNumbers.join(', ')}] (${clientIP})`);
	  }
  } else if (message.startsWith('SEQUENCE:')) {
    // 기존 연속 호출 (호환성 유지)
    const numbersStr = message.substring(9);
    const newNumbers = numbersStr.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    
    if (newNumbers.length > 0) {
      const maxNumbers = storeKey === '3ru' ? 5 : 10;
      store.currentNumbers = newNumbers.slice(0, maxNumbers);
      
      const lastNumber = store.currentNumbers[store.currentNumbers.length - 1];
      
      responseData = {
        type: 'CALL',
        list: [...store.currentNumbers],
        calledNumber: lastNumber,
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`📢 ${store.name} 연속 호출: [${newNumbers.join(', ')}] (${clientIP})`);
    }
  } else if (message.startsWith('STATUS:')) {
    const statusText = message.substring(7);
    responseData = {
      type: 'STATUS',
      text: statusText,
      timestamp: new Date().toISOString(),
      triggeredBy: clientIP
    };
    
    console.log(`📊 ${store.name} 상태 메시지: "${statusText}" (${clientIP})`);
  } else if (message.startsWith('AUDIO:')) {
	  const audioType = message.substring(6);
	  responseData = {
		type: 'AUDIO',
		audioType: audioType,
		timestamp: new Date().toISOString(),
		triggeredBy: clientIP
	  };
	  
	  console.log(`🔊 ${store.name} 오디오 재생 요청: ${audioType} (${clientIP})`);
  } else if (message.startsWith('MSG:')) {
    const text = message.substring(4);
    
    if (storeKey === '1ru') {
      const serveUntilMatch = text.match(/(\d+)번 손님까지 드립니다/);
      if (serveUntilMatch) {
        const targetNumber = parseInt(serveUntilMatch[1]);
        
        if (!store.currentNumbers.includes(targetNumber)) {
          store.currentNumbers.push(targetNumber);
          
          if (store.currentNumbers.length > 10) {
            store.currentNumbers.shift();
          }
        }
        
        responseData = {
          type: 'SERVE_UNTIL',
          text: text,
          number: targetNumber,
          currentNumbers: [...store.currentNumbers],
          timestamp: new Date().toISOString(),
          triggeredBy: clientIP
        };
        
        console.log(`🍽️ ${store.name} ${targetNumber}번 손님까지 서빙: "${text}" (${clientIP}) - 목록: [${store.currentNumbers.join(', ')}]`);
      } else {
        responseData = {
          type: 'MSG',
          text: text,
          timestamp: new Date().toISOString(),
          triggeredBy: clientIP
        };
        
        console.log(`💬 ${store.name} 메시지: "${text}" (${clientIP})`);
      }
    } else {
      responseData = {
        type: 'MSG',
        text: text,
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`💬 ${store.name} 메시지: "${text}" (${clientIP})`);
    }
  } else if (message.startsWith('TIME:') && storeKey === '1ru') {
    const parts = message.split(':');
    if (parts.length >= 3) {
      const sam = parseInt(parts[1]);
      const noodle = parseInt(parts[2]);
      if (!isNaN(sam) && !isNaN(noodle)) {
        responseData = {
          type: 'TIME',
          sam: sam,
          noodle: noodle,
          timestamp: new Date().toISOString(),
          triggeredBy: clientIP
        };
        
        console.log(`⏱ ${store.name} 시간 업데이트: 삼겹살 ${sam}분, 국수 ${noodle}분 (${clientIP})`);
      }
    }
  } else if (message === 'CLEAR') {
    store.currentNumbers = [];
    responseData = {
      type: 'CALL',
      list: [],
      timestamp: new Date().toISOString(),
      triggeredBy: clientIP
    };
    
    console.log(`🗑️ ${store.name} 모든 번호 지움 (${clientIP})`);
  }

  if (responseData) {
    const sent = broadcastToDisplays(storeKey, JSON.stringify(responseData));
    console.log(`📡 ${store.name} ${sent}개 디스플레이에 브로드캐스트`);
    
    if (responseData.type === 'CALL' || responseData.type === 'SERVE_UNTIL') {
      notifyInputClients(storeKey, {
        type: 'CALL',
        list: [...store.currentNumbers],
        timestamp: responseData.timestamp
      });
    }
  }
}

function broadcastToDisplays(storeKey, message) {
  const store = stores[storeKey];
  let sentCount = 0;
  const deadClients = [];
  
  store.displayClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
        sentCount++;
      } catch (error) {
        console.error(`❌ ${store.name} 디스플레이 브로드캐스트 실패:`, error.message);
        deadClients.push(ws);
      }
    } else {
      deadClients.push(ws);
    }
  });
  
  deadClients.forEach(ws => removeClient(store.displayClients, ws));
  return sentCount;
}

function notifyInputClients(storeKey, data) {
  const store = stores[storeKey];
  const message = JSON.stringify(data);
  let sentCount = 0;
  const deadClients = [];
  
  store.inputClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
        sentCount++;
      } catch (error) {
        console.error(`❌ ${store.name} 입력 클라이언트 알림 실패:`, error.message);
        deadClients.push(ws);
      }
    } else {
      deadClients.push(ws);
    }
  });
  
  deadClients.forEach(ws => removeClient(store.inputClients, ws));
  
  if (sentCount > 0) {
    console.log(`📱 ${store.name} ${sentCount}개 입력 클라이언트에 알림`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 통빱 다중 매장 호출벨 시스템 시작!`);
  console.log(`📱 3루점 호출: http://localhost:${PORT}/input.html`);
  console.log(`📱 1루점 호출: http://localhost:${PORT}/input1.html`);
  console.log(`🖥️ 3루점 디스플레이: http://localhost:${PORT}/display.html`);
  console.log(`🖥️ 1루점 디스플레이: http://localhost:${PORT}/display1.html`);
  console.log(`💡 외부 접속: http://[서버IP]:${PORT}`);
  console.log(`📊 상태 확인: http://localhost:${PORT}/health`);
  console.log(`⏰ ${new Date().toLocaleString()}`);
  
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
  
  function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} 신호 받음 - 정리 시작`);
    
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    
    const shutdownMessage = JSON.stringify({
      type: 'SERVER_SHUTDOWN',
      message: '서버가 곧 종료됩니다',
      timestamp: new Date().toISOString()
    });
    
    for (const storeKey in stores) {
      const store = stores[storeKey];
      
      store.displayClients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(shutdownMessage);
            ws.close(1001, 'Server shutting down');
          } catch (error) {
            console.error(`${store.name} 클라이언트 종료 알림 실패:`, error.message);
          }
        }
      });
      
      store.inputClients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(shutdownMessage);
            ws.close(1001, 'Server shutting down');
          } catch (error) {
            console.error(`${store.name} 클라이언트 종료 알림 실패:`, error.message);
          }
        }
      });
    }
    
    wss.close(() => {
      console.log('🔌 WebSocket 서버 종료됨');
      
      server.close(() => {
        console.log('✅ HTTP 서버 정상 종료됨');
        process.exit(0);
      });
    });
    
    setTimeout(() => {
      console.log('⚡ 강제 종료');
      process.exit(1);
    }, 10000);
  }
});