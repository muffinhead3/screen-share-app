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

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);
        cb(null, `${Date.now()}-${baseName}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('PDF 파일만 업로드 가능합니다.'), false);
        }
    },
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});

const sessions = new Map();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'consultant.html'));
});

app.get('/view/:sessionId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.post('/api/create-session', (req, res) => {
    const sessionId = uuidv4().substring(0, 8);
    sessions.set(sessionId, {
        id: sessionId,
        pdfUrl: null,
        currentPage: 1,
        totalPages: 1,
        drawings: [],
        createdAt: new Date(),
        consultantConnected: false,
        customerConnected: false
    });
    
    const shareUrl = `${req.protocol}://${req.get('host')}/view/${sessionId}`;
    
    res.json({
        success: true,
        sessionId: sessionId,
        shareUrl: shareUrl
    });
});

app.post('/api/upload-pdf/:sessionId', upload.single('pdf'), (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    }
    
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'PDF 파일이 필요합니다.' });
    }
    
    const pdfUrl = `/uploads/${req.file.filename}`;
    session.pdfUrl = pdfUrl;
    session.drawings = [];
    session.currentPage = 1;
    
    io.to(sessionId).emit('pdf-loaded', { pdfUrl: pdfUrl });
    
    res.json({
        success: true,
        pdfUrl: pdfUrl
    });
});

app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: '세션을 찾을 수 없습니다.' });
    }
    
    res.json({
        success: true,
        session: session
    });
});

io.on('connection', (socket) => {
    console.log('새 연결:', socket.id);
    
    socket.on('join-session', (data) => {
        const { sessionId, role } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            socket.emit('error', { message: '존재하지 않는 세션입니다.' });
            return;
        }
        
        socket.join(sessionId);
        socket.sessionId = sessionId;
        socket.role = role;
        
        if (role === 'consultant') {
            session.consultantConnected = true;
        } else {
            session.customerConnected = true;
        }
        
        socket.emit('session-state', {
            pdfUrl: session.pdfUrl,
            currentPage: session.currentPage,
            totalPages: session.totalPages,
            drawings: session.drawings
        });
        
        socket.to(sessionId).emit('user-joined', { role: role });
        
        console.log(`${role}이(가) 세션 ${sessionId}에 참가`);
    });
    
    socket.on('page-change', (data) => {
        const { sessionId, page, totalPages } = data;
        const session = sessions.get(sessionId);
        
        if (session) {
            session.currentPage = page;
            session.totalPages = totalPages;
            session.drawings = [];
            
            socket.to(sessionId).emit('page-changed', { 
                page: page,
                totalPages: totalPages 
            });
        }
    });
    
    socket.on('draw-start', (data) => {
        socket.to(data.sessionId).emit('draw-started', data);
    });
    
    socket.on('drawing', (data) => {
        const session = sessions.get(data.sessionId);
        if (session) {
            socket.to(data.sessionId).emit('drawing-update', data);
        }
    });
    
    socket.on('draw-end', (data) => {
        const session = sessions.get(data.sessionId);
        if (session && data.drawingData) {
            session.drawings.push(data.drawingData);
            socket.to(data.sessionId).emit('draw-ended', data);
        }
    });
    
    socket.on('clear-drawings', (data) => {
        const session = sessions.get(data.sessionId);
        if (session) {
            session.drawings = [];
            socket.to(data.sessionId).emit('drawings-cleared');
        }
    });
    
    socket.on('undo-drawing', (data) => {
        const session = sessions.get(data.sessionId);
        if (session && session.drawings.length > 0) {
            session.drawings.pop();
            socket.to(data.sessionId).emit('drawing-undone');
        }
    });
    
    socket.on('pointer-move', (data) => {
        socket.to(data.sessionId).emit('pointer-moved', {
            x: data.x,
            y: data.y,
            visible: data.visible
        });
    });
    
    socket.on('disconnect', () => {
        if (socket.sessionId) {
            const session = sessions.get(socket.sessionId);
            if (session) {
                if (socket.role === 'consultant') {
                    session.consultantConnected = false;
                } else {
                    session.customerConnected = false;
                }
                socket.to(socket.sessionId).emit('user-left', { role: socket.role });
            }
        }
        console.log('연결 해제:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;

const fs = require('fs');
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

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
    console.log('  3. PDF 파일 업로드');
    console.log('  4. 생성된 링크를 고객에게 전달');
    console.log('');
    console.log('========================================');
});