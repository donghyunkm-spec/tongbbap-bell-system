const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let displayClients = new Set();
let inputClients = new Set();
let currentNumbers = [];

// ✅ 환경 변수로 포트 설정 (서버 배포시 필요)
const PORT = process.env.PORT || 3000;

// ✅ 헬스체크 엔드포인트 추가 (서버 모니터링용)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    displays: displayClients.size,
    inputs: inputClients.size 
  });
});

// ✅ 디스플레이 상태 주기적 체크 (30초마다)
setInterval(() => {
  checkDisplayStatus();
}, 30000);

function checkDisplayStatus() {
  const activeDisplays = [];
  displayClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      activeDisplays.push(client);
      client.send(JSON.stringify({ type: 'PING' }));
    }
  });
  
  displayClients = new Set(activeDisplays);
  
  if (displayClients.size === 0) {
    notifyInputClients({ type: 'DISPLAY_OFF' });
  } else {
    notifyInputClients({ type: 'DISPLAY_ON' });
  }
}

// ✅ HTML, JS, CSS 등 정적 파일 제공
app.use(express.static(__dirname));

// ✅ 루트 경로를 직원 화면으로 설정
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'input.html'));
});

// ✅ WebSocket 연결 처리
wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`🔗 새 클라이언트 연결됨: ${clientIP}`);

  ws.on('message', (data) => {
    const message = data.toString();
    console.log(`📩 받은 메시지 (${clientIP}):`, message);

    if (message === 'DISPLAY') {
      displayClients.add(ws);
      console.log(`📺 디스플레이 연결됨 (총 ${displayClients.size}개)`);
      notifyInputClients({ type: 'DISPLAY_ON' });
    } else if (message === 'INPUT') {
      inputClients.add(ws);
      console.log(`📱 입력 클라이언트 연결됨 (총 ${inputClients.size}개)`);
      
      if (displayClients.size > 0) {
        ws.send(JSON.stringify({ type: 'DISPLAY_ON' }));
      } else {
        ws.send(JSON.stringify({ type: 'DISPLAY_OFF' }));
      }
      
      if (currentNumbers.length > 0) {
        ws.send(JSON.stringify({ type: 'CALL', list: currentNumbers }));
      }
    } else {
      processMessage(message);
    }
  });

  ws.on('close', () => {
    displayClients.delete(ws);
    inputClients.delete(ws);
    console.log(`❌ 클라이언트 연결 해제됨: ${clientIP}`);
    
    if (displayClients.size === 0) {
      notifyInputClients({ type: 'DISPLAY_OFF' });
    }
  });

  ws.on('error', (err) => {
    console.error('⚠️ WebSocket 에러:', err.message);
  });
});

function processMessage(message) {
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
        list: [...currentNumbers]
      };
    }
  } else if (message.startsWith('SEQUENCE:')) {
    const numbersStr = message.substring(9);
    const newNumbers = numbersStr.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    
    if (newNumbers.length > 0) {
      currentNumbers = newNumbers.slice(0, 5);
      
      responseData = {
        type: 'CALL',
        list: [...currentNumbers]
      };
    }
  } else if (message.startsWith('MSG:')) {
    const text = message.substring(4);
    responseData = {
      type: 'MSG',
      text: text
    };
  } else if (message.startsWith('TIME:')) {
    const parts = message.split(':');
    if (parts.length >= 3) {
      const sam = parseInt(parts[1]);
      const noodle = parseInt(parts[2]);
      if (!isNaN(sam) && !isNaN(noodle)) {
        responseData = {
          type: 'TIME',
          sam: sam,
          noodle: noodle
        };
      }
    }
  } else if (message === 'CLEAR') {
    currentNumbers = [];
    responseData = {
      type: 'CALL',
      list: []
    };
  }

  if (responseData) {
    broadcastToDisplays(JSON.stringify(responseData));
    if (responseData.type === 'CALL') {
      notifyInputClients(responseData);
    }
  }
}

function broadcastToDisplays(message) {
  displayClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function notifyInputClients(data) {
  const message = JSON.stringify(data);
  inputClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ✅ 서버 시작 - 모든 네트워크 인터페이스에서 접속 허용
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 통빱 호출벨 시스템 시작!`);
  console.log(`📱 직원용: http://localhost:${PORT}`);
  console.log(`🖥️ 디스플레이: http://localhost:${PORT}/display.html`);
  console.log(`💡 외부 접속: http://[서버IP]:${PORT}`);
  console.log(`⏰ ${new Date().toLocaleString()}`);
  
  // ✅ 프로세스 종료 시 정리
  process.on('SIGTERM', () => {
    console.log('🛑 서버 종료 신호 받음');
    server.close(() => {
      console.log('✅ 서버 정상 종료됨');
      process.exit(0);
    });
  });
});