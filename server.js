const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let displayClients = new Map(); // Set 대신 Map으로 변경하여 메타데이터 저장
let inputClients = new Map();
let currentNumbers = [];

// ✅ 환경 변수로 포트 설정 (서버 배포시 필요)
const PORT = process.env.PORT || 3000;

// 클라이언트 메타데이터 관리
function addClient(clientMap, ws, req) {
  const clientInfo = {
    ws: ws,
    ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || 'Unknown',
    connectTime: new Date(),
    lastPing: new Date(),
    isAlive: true
  };
  clientMap.set(ws, clientInfo);
  return clientInfo;
}

function removeClient(clientMap, ws) {
  return clientMap.delete(ws);
}

function getClientInfo(clientMap, ws) {
  return clientMap.get(ws);
}

// ✅ 헬스체크 엔드포인트 추가 (서버 모니터링용)
app.get('/health', (req, res) => {
  const now = new Date();
  const displayStats = Array.from(displayClients.values()).map(client => ({
    ip: client.ip,
    connected: Math.floor((now - client.connectTime) / 1000) + 's',
    lastPing: Math.floor((now - client.lastPing) / 1000) + 's ago',
    alive: client.isAlive
  }));
  
  const inputStats = Array.from(inputClients.values()).map(client => ({
    ip: client.ip,
    connected: Math.floor((now - client.connectTime) / 1000) + 's',
    lastPing: Math.floor((now - client.lastPing) / 1000) + 's ago',
    alive: client.isAlive
  }));

  res.json({ 
    status: 'ok', 
    timestamp: now.toISOString(),
    displays: {
      count: displayClients.size,
      clients: displayStats
    },
    inputs: {
      count: inputClients.size,
      clients: inputStats
    },
    currentNumbers: currentNumbers
  });
});

// ✅ 상세 상태 엔드포인트
app.get('/status', (req, res) => {
  res.json({
    server: 'running',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    displays: displayClients.size,
    inputs: inputClients.size,
    currentNumbers: currentNumbers,
    timestamp: new Date().toISOString()
  });
});

// ✅ 하트비트 및 연결 상태 체크 (15초마다)
const HEARTBEAT_INTERVAL = 15000;
const CLIENT_TIMEOUT = 60000; // 60초 타임아웃

function heartbeat() {
  console.log(`💓 하트비트 체크 시작 - Display: ${displayClients.size}, Input: ${inputClients.size}`);
  
  // 디스플레이 클라이언트 체크
  const deadDisplays = [];
  displayClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (clientInfo.isAlive === false) {
        console.log(`💀 Display 클라이언트 응답 없음 (${clientInfo.ip}) - 연결 종료`);
        ws.terminate();
        deadDisplays.push(ws);
      } else {
        clientInfo.isAlive = false;
        try {
          ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
        } catch (error) {
          console.error(`❌ Display 클라이언트 PING 전송 실패 (${clientInfo.ip}):`, error.message);
          deadDisplays.push(ws);
        }
      }
    } else {
      console.log(`🔌 Display 클라이언트 연결 끊김 (${clientInfo.ip})`);
      deadDisplays.push(ws);
    }
  });

  // 입력 클라이언트 체크
  const deadInputs = [];
  inputClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (clientInfo.isAlive === false) {
        console.log(`💀 Input 클라이언트 응답 없음 (${clientInfo.ip}) - 연결 종료`);
        ws.terminate();
        deadInputs.push(ws);
      } else {
        clientInfo.isAlive = false;
        try {
          ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
        } catch (error) {
          console.error(`❌ Input 클라이언트 PING 전송 실패 (${clientInfo.ip}):`, error.message);
          deadInputs.push(ws);
        }
      }
    } else {
      console.log(`🔌 Input 클라이언트 연결 끊김 (${clientInfo.ip})`);
      deadInputs.push(ws);
    }
  });

  // 죽은 클라이언트들 정리
  deadDisplays.forEach(ws => {
    removeClient(displayClients, ws);
  });
  deadInputs.forEach(ws => {
    removeClient(inputClients, ws);
  });

  // 디스플레이 상태 변경 알림
  if (deadDisplays.length > 0) {
    console.log(`📺 디스플레이 클라이언트 ${deadDisplays.length}개 정리됨`);
    if (displayClients.size === 0) {
      notifyInputClients({ type: 'DISPLAY_OFF', reason: 'all_disconnected' });
    }
  }

  console.log(`💓 하트비트 완료 - Display: ${displayClients.size}, Input: ${inputClients.size}`);
}

const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL);

// ✅ 오래된 연결 정리 (5분마다)
function cleanupOldConnections() {
  const now = Date.now();
  const oldDisplays = [];
  const oldInputs = [];

  displayClients.forEach((clientInfo, ws) => {
    if (now - clientInfo.lastPing.getTime() > CLIENT_TIMEOUT) {
      console.log(`🗑️ 오래된 Display 연결 정리 (${clientInfo.ip})`);
      oldDisplays.push(ws);
    }
  });

  inputClients.forEach((clientInfo, ws) => {
    if (now - clientInfo.lastPing.getTime() > CLIENT_TIMEOUT) {
      console.log(`🗑️ 오래된 Input 연결 정리 (${clientInfo.ip})`);
      oldInputs.push(ws);
    }
  });

  oldDisplays.forEach(ws => {
    ws.terminate();
    removeClient(displayClients, ws);
  });

  oldInputs.forEach(ws => {
    ws.terminate();
    removeClient(inputClients, ws);
  });

  if (oldDisplays.length > 0 && displayClients.size === 0) {
    notifyInputClients({ type: 'DISPLAY_OFF', reason: 'timeout_cleanup' });
  }
}

const cleanupTimer = setInterval(cleanupOldConnections, 5 * 60 * 1000); // 5분

// ✅ HTML, JS, CSS 등 정적 파일 제공
app.use(express.static(__dirname));

// ✅ 루트 경로를 직원 화면으로 설정
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'input.html'));
});

// ✅ WebSocket 연결 처리
wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  console.log(`🔗 새 클라이언트 연결됨: ${clientIP} (${userAgent.split(' ')[0]})`);

  // 연결 시 임시 정보 저장
  let clientInfo = {
    ip: clientIP,
    userAgent: userAgent,
    connectTime: new Date(),
    lastPing: new Date(),
    isAlive: true,
    type: 'unknown'
  };

  ws.on('message', (data) => {
    const message = data.toString();
    console.log(`📩 받은 메시지 (${clientIP}):`, message);

    // PONG 응답 처리
    if (message.startsWith('{') && message.includes('PONG')) {
      try {
        const pongData = JSON.parse(message);
        if (pongData.type === 'PONG') {
          const info = getClientInfo(displayClients, ws) || getClientInfo(inputClients, ws);
          if (info) {
            info.isAlive = true;
            info.lastPing = new Date();
            console.log(`🏓 PONG 받음 (${clientIP})`);
          }
          return;
        }
      } catch (e) {
        // JSON이 아닌 경우 무시
      }
    }

    if (message === 'DISPLAY') {
      clientInfo.type = 'display';
      clientInfo = addClient(displayClients, ws, req);
      console.log(`📺 디스플레이 등록됨 (${clientIP}) - 총 ${displayClients.size}개`);
      notifyInputClients({ 
        type: 'DISPLAY_ON', 
        count: displayClients.size,
        timestamp: new Date().toISOString()
      });
      
      // 현재 번호가 있으면 새 디스플레이에 전송
      if (currentNumbers.length > 0) {
        try {
          ws.send(JSON.stringify({
            type: 'CALL',
            list: [...currentNumbers],
            timestamp: new Date().toISOString()
          }));
        } catch (error) {
          console.error(`❌ 디스플레이에 현재 번호 전송 실패:`, error.message);
        }
      }
      
    } else if (message === 'INPUT') {
      clientInfo.type = 'input';
      clientInfo = addClient(inputClients, ws, req);
      console.log(`📱 입력 클라이언트 등록됨 (${clientIP}) - 총 ${inputClients.size}개`);
      
      // 디스플레이 상태 알림
      try {
        if (displayClients.size > 0) {
          ws.send(JSON.stringify({ 
            type: 'DISPLAY_ON', 
            count: displayClients.size,
            timestamp: new Date().toISOString()
          }));
        } else {
          ws.send(JSON.stringify({ 
            type: 'DISPLAY_OFF', 
            reason: 'no_displays',
            timestamp: new Date().toISOString()
          }));
        }
        
        // 현재 번호 상태 전송
        if (currentNumbers.length > 0) {
          ws.send(JSON.stringify({ 
            type: 'CALL', 
            list: [...currentNumbers],
            timestamp: new Date().toISOString()
          }));
        }
      } catch (error) {
        console.error(`❌ 입력 클라이언트에 상태 전송 실패:`, error.message);
      }
      
    } else {
      // 일반 메시지 처리
      processMessage(message, clientIP);
    }
  });

  ws.on('close', (code, reason) => {
    const wasDisplay = removeClient(displayClients, ws);
    const wasInput = removeClient(inputClients, ws);
    
    console.log(`❌ 클라이언트 연결 해제됨: ${clientIP} (코드: ${code}, 이유: ${reason})`);
    
    if (wasDisplay) {
      console.log(`📺 디스플레이 해제됨 - 남은 개수: ${displayClients.size}`);
      if (displayClients.size === 0) {
        notifyInputClients({ 
          type: 'DISPLAY_OFF', 
          reason: 'disconnected',
          timestamp: new Date().toISOString()
        });
      }
    }
    
    if (wasInput) {
      console.log(`📱 입력 클라이언트 해제됨 - 남은 개수: ${inputClients.size}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`⚠️ WebSocket 에러 (${clientIP}):`, err.message);
    removeClient(displayClients, ws);
    removeClient(inputClients, ws);
  });

  // 연결 즉시 PING 전송하여 연결 상태 확인
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
      } catch (error) {
        console.error(`❌ 초기 PING 전송 실패 (${clientIP}):`, error.message);
      }
    }
  }, 1000);
});

function processMessage(message, clientIP) {
  let responseData = null;

  if (message.startsWith('CALL:')) {
    const number = parseInt(message.split(':')[1]);
    if (!isNaN(number)) {
      if (!currentNumbers.includes(number)) {
        currentNumbers.push(number);
        
        if (currentNumbers.length > 5) {
          currentNumbers.shift();
        }
      }
      
      responseData = {
        type: 'CALL',
        list: [...currentNumbers],
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`📢 호출 요청: ${number} (${clientIP}) - 현재 목록: [${currentNumbers.join(', ')}]`);
    }
  } else if (message.startsWith('SEQUENCE:')) {
    const numbersStr = message.substring(9);
    const newNumbers = numbersStr.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    
    if (newNumbers.length > 0) {
      currentNumbers = newNumbers.slice(0, 5);
      
      responseData = {
        type: 'CALL',
        list: [...currentNumbers],
        timestamp: new Date().toISOString(),
        triggeredBy: clientIP
      };
      
      console.log(`📢 연속 호출: [${newNumbers.join(', ')}] (${clientIP})`);
    }
  } else if (message.startsWith('MSG:')) {
    const text = message.substring(4);
    responseData = {
      type: 'MSG',
      text: text,
      timestamp: new Date().toISOString(),
      triggeredBy: clientIP
    };
    
    console.log(`💬 메시지 전송: "${text}" (${clientIP})`);
  } else if (message.startsWith('TIME:')) {
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
        
        console.log(`⏱ 시간 업데이트: 삼겹살 ${sam}분, 국수 ${noodle}분 (${clientIP})`);
      }
    }
  } else if (message === 'CLEAR') {
    currentNumbers = [];
    responseData = {
      type: 'CALL',
      list: [],
      timestamp: new Date().toISOString(),
      triggeredBy: clientIP
    };
    
    console.log(`🗑️ 모든 번호 지움 (${clientIP})`);
  }

  if (responseData) {
    const sent = broadcastToDisplays(JSON.stringify(responseData));
    console.log(`📡 ${sent}개 디스플레이에 브로드캐스트 완료`);
    
    if (responseData.type === 'CALL') {
      notifyInputClients(responseData);
    }
  }
}

function broadcastToDisplays(message) {
  let sentCount = 0;
  const deadClients = [];
  
  displayClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
        sentCount++;
      } catch (error) {
        console.error(`❌ 디스플레이 브로드캐스트 실패 (${clientInfo.ip}):`, error.message);
        deadClients.push(ws);
      }
    } else {
      deadClients.push(ws);
    }
  });
  
  // 죽은 클라이언트 정리
  deadClients.forEach(ws => {
    removeClient(displayClients, ws);
  });
  
  return sentCount;
}

function notifyInputClients(data) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  const deadClients = [];
  
  inputClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
        sentCount++;
      } catch (error) {
        console.error(`❌ 입력 클라이언트 알림 실패 (${clientInfo.ip}):`, error.message);
        deadClients.push(ws);
      }
    } else {
      deadClients.push(ws);
    }
  });
  
  // 죽은 클라이언트 정리
  deadClients.forEach(ws => {
    removeClient(inputClients, ws);
  });
  
  if (sentCount > 0) {
    console.log(`📱 ${sentCount}개 입력 클라이언트에 알림 전송`);
  }
}

// ✅ 서버 시작 - 모든 네트워크 인터페이스에서 접속 허용
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 통빱 호출벨 시스템 시작!`);
  console.log(`📱 직원용: http://localhost:${PORT}`);
  console.log(`🖥️ 디스플레이: http://localhost:${PORT}/display.html`);
  console.log(`💡 외부 접속: http://[서버IP]:${PORT}`);
  console.log(`📊 상태 확인: http://localhost:${PORT}/health`);
  console.log(`⏰ ${new Date().toLocaleString()}`);
  console.log(`💓 하트비트 간격: ${HEARTBEAT_INTERVAL/1000}초`);
  console.log(`⏱️ 클라이언트 타임아웃: ${CLIENT_TIMEOUT/1000}초`);
  
  // ✅ 프로세스 종료 시 정리
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
  
  function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} 신호 받음 - 정리 시작`);
    
    // 타이머들 정리
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    
    // 모든 클라이언트에 서버 종료 알림
    const shutdownMessage = JSON.stringify({
      type: 'SERVER_SHUTDOWN',
      message: '서버가 곧 종료됩니다',
      timestamp: new Date().toISOString()
    });
    
    displayClients.forEach((clientInfo, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(shutdownMessage);
          ws.close(1001, 'Server shutting down');
        } catch (error) {
          console.error('클라이언트 종료 알림 실패:', error.message);
        }
      }
    });
    
    inputClients.forEach((clientInfo, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(shutdownMessage);
          ws.close(1001, 'Server shutting down');
        } catch (error) {
          console.error('클라이언트 종료 알림 실패:', error.message);
        }
      }
    });
    
    // WebSocket 서버 종료
    wss.close(() => {
      console.log('🔌 WebSocket 서버 종료됨');
      
      // HTTP 서버 종료
      server.close(() => {
        console.log('✅ HTTP 서버 정상 종료됨');
        process.exit(0);
      });
    });
    
    // 강제 종료 타이머 (10초)
    setTimeout(() => {
      console.log('⚡ 강제 종료');
      process.exit(1);
    }, 10000);
  }
});