const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 파일 업로드 설정 (PDF + 이미지)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'uploads'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('지원하지 않는 파일 형식입니다.'));
        }
    }
});

// 세션 저장소
const sessions = new Map();

// 메인 페이지
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'consultant.html'));
});

// 고객 페이지
app.get('/view/:sessionId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

// 세션 생성 API
app.post('/api/create-session', (req, res) => {
    const sessionId = uuidv4().slice(0, 8);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    
    sessions.set(sessionId, {
        id: sessionId,
        fileUrl: null,
        fileType: null,
        currentPage: 1,
        totalPages: 1,
        drawings: [],
        users: { 
            consultant: null, 
            customers: new Set() // 여러 고객 지원
        }
    });
    
    res.json({
        success: true,
        sessionId: sessionId,
        shareUrl: `${protocol}://${host}/view/${sessionId}`
    });
});

// 파일 업로드 API (PDF + 이미지)
app.post('/api/upload-file/:sessionId', upload.single('file'), (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    }
    
    if (!req.file) {
        return res.status(400).json({ success: false, message: '파일이 업로드되지 않았습니다.' });
    }
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
    const fileType = req.body.fileType || (req.file.mimetype === 'application/pdf' ? 'pdf' : 'image');
    
    session.fileUrl = fileUrl;
    session.fileType = fileType;
    session.currentPage = 1;
    session.drawings = [];
    
    // 연결된 고객에게 파일 로드 알림
    io.to(sessionId).emit('file-loaded', { 
        fileUrl: fileUrl,
        fileType: fileType
    });
    
    res.json({
        success: true,
        fileUrl: fileUrl,
        fileType: fileType
    });
});

// 기존 PDF 업로드 API (하위 호환성)
app.post('/api/upload-pdf/:sessionId', upload.single('pdf'), (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    }
    
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'PDF가 업로드되지 않았습니다.' });
    }
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const pdfUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
    
    session.fileUrl = pdfUrl;
    session.fileType = 'pdf';
    session.currentPage = 1;
    session.drawings = [];
    
    io.to(sessionId).emit('pdf-loaded', { pdfUrl: pdfUrl });
    
    res.json({
        success: true,
        pdfUrl: pdfUrl
    });
});

// 세션 정보 조회 API
app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    }
    
    res.json({
        success: true,
        session: {
            id: session.id,
            fileUrl: session.fileUrl,
            fileType: session.fileType,
            currentPage: session.currentPage,
            totalPages: session.totalPages,
            drawings: session.drawings
        }
    });
});

// 접속자 수 전송 함수
function sendCustomerCount(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        const count = session.users.customers.size;
        io.to(sessionId).emit('customer-count', { count: count });
    }
}

// Socket.io 연결 처리
io.on('connection', (socket) => {
    console.log('새 클라이언트 연결:', socket.id);
    
    socket.on('join-session', (data) => {
        const { sessionId, role } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            socket.emit('error', { message: '세션을 찾을 수 없습니다.' });
            return;
        }
        
        socket.join(sessionId);
        socket.sessionId = sessionId;
        socket.role = role;
        
        if (role === 'consultant') {
            session.users.consultant = socket.id;
            // 상담사 접속 시 현재 고객 수 전송
            sendCustomerCount(sessionId);
        } else {
            session.users.customers.add(socket.id);
            // 고객 접속 시 현재 세션 상태 전송
            socket.emit('session-state', {
                fileUrl: session.fileUrl,
                fileType: session.fileType,
                currentPage: session.currentPage,
                totalPages: session.totalPages,
                drawings: session.drawings
            });
            // 모든 사용자에게 고객 수 업데이트
            sendCustomerCount(sessionId);
        }
        
        socket.to(sessionId).emit('user-joined', { role: role });
        console.log(`${role}이(가) 세션 ${sessionId}에 참가 (고객 수: ${session.users.customers.size})`);
    });
    
    socket.on('page-change', (data) => {
        const session = sessions.get(data.sessionId);
        if (session) {
            session.currentPage = data.page;
            session.totalPages = data.totalPages;
            session.drawings = [];
            socket.to(data.sessionId).emit('page-changed', {
                page: data.page,
                totalPages: data.totalPages
            });
        }
    });
    
    socket.on('draw-start', (data) => {
        socket.to(data.sessionId).emit('draw-started', data);
    });
    
    socket.on('drawing', (data) => {
        socket.to(data.sessionId).emit('drawing-update', data);
    });
    
    socket.on('draw-end', (data) => {
        const session = sessions.get(data.sessionId);
        if (session && data.drawingData) {
            session.drawings.push(data.drawingData);
        }
        socket.to(data.sessionId).emit('draw-ended', data);
    });
    
    // 지우개 이벤트
    socket.on('eraser-start', (data) => {
        socket.to(data.sessionId).emit('eraser-started', data);
    });
    
    socket.on('erasing', (data) => {
        socket.to(data.sessionId).emit('erasing-update', data);
    });
    
    socket.on('eraser-end', (data) => {
        const session = sessions.get(data.sessionId);
        if (session && data.eraserData) {
            session.drawings.push(data.eraserData);
        }
        socket.to(data.sessionId).emit('eraser-ended', data);
    });
    
    socket.on('clear-drawings', (data) => {
        const session = sessions.get(data.sessionId);
        if (session) {
            session.drawings = [];
        }
        socket.to(data.sessionId).emit('drawings-cleared');
    });
    
    socket.on('undo-drawing', (data) => {
        const session = sessions.get(data.sessionId);
        if (session && session.drawings.length > 0) {
            session.drawings.pop();
        }
        socket.to(data.sessionId).emit('drawing-undone');
    });
    
    socket.on('pointer-move', (data) => {
        socket.to(data.sessionId).emit('pointer-moved', data);
    });
    
    socket.on('disconnect', () => {
        if (socket.sessionId) {
            const session = sessions.get(socket.sessionId);
            if (session) {
                if (socket.role === 'consultant') {
                    session.users.consultant = null;
                } else {
                    session.users.customers.delete(socket.id);
                    // 고객 수 업데이트 전송
                    sendCustomerCount(socket.sessionId);
                }
            }
            socket.to(socket.sessionId).emit('user-left', { role: socket.role });
            console.log(`${socket.role}이(가) 세션 ${socket.sessionId}에서 나감`);
        }
        console.log('클라이언트 연결 해제:', socket.id);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  상담사-고객 화면 공유 서비스 시작!');
    console.log('========================================');
    console.log('');
    console.log(`  상담사 페이지: http://localhost:${PORT}`);
    console.log('');
    console.log('  사용 방법:');
    console.log('  1. 위 주소로 접속');
    console.log('  2. "새 상담 세션 시작" 클릭');
    console.log('  3. PDF 또는 이미지 파일 업로드');
    console.log('  4. 생성된 링크를 고객에게 전달');
    console.log('');
    console.log('  기능:');
    console.log('  - PDF / 이미지 파일 지원 (JPG, PNG, GIF)');
    console.log('  - 화면 캡처 저장');
    console.log('  - 줌 확대/축소 (각자 독립적)');
    console.log('  - 디바이스별 자동 최적화');
    console.log('  - 모자이크/블러 도구');
    console.log('  - 접속자 수 표시');
    console.log('');
    console.log('========================================');
});
