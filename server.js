const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const SECRET = 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Resend setup
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Load database files
const studentsDB = JSON.parse(fs.readFileSync('./students.json', 'utf8'));
const facultySectionsDB = JSON.parse(fs.readFileSync('./faculty-sections.json', 'utf8'));

// Email-based role mapping
function getRoleFromEmail(email) {
    const lowerEmail = email.toLowerCase();
    
    // Specific email overrides
    const specificRoles = {
        '25wh1a05g5@bvrithyderabad.edu.in': 'teacher',
        '25wh1a05d1@bvrithyderabad.edu.in': 'hod',
        'bhaktitakey@gmail.com': 'teacher',
        'watermelon37453@gmail.com': 'hod'
    };
    
    // Check specific emails first
    if (specificRoles[lowerEmail]) {
        return specificRoles[lowerEmail];
    }
    
    // Check if HOD domain
    if (lowerEmail.endsWith('hod.bvrithyderabad.edu.in')) {
        return 'hod';
    }
    
    // Check if student (10 chars before @ and 'wh' at positions 3-4)
    if (lowerEmail.endsWith('bvrithyderabad.edu.in')) {
        const username = lowerEmail.split('@')[0];
        if (username.length === 10 && username.substring(2, 4) === 'wh') {
            return 'student';
        }
        // If not student, then teacher
        return 'teacher';
    }
    
    // Not authorized
    return null;
}

// In-memory database
const users = [];
let requests = [];
let requestIdCounter = 1;

// Auth middleware
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Google OAuth login
app.post('/api/auth/google', async (req, res) => {
    try {
        const { token } = req.body;
        
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID
        });
        
        const payload = ticket.getPayload();
        const email = payload.email;
        const name = payload.name;
        
        // Determine role from email domain
        const role = getRoleFromEmail(email);
        
        if (!role) {
            return res.status(403).json({ 
                error: 'Email domain not authorized. Please use university email.' 
            });
        }
        
        // Find or create user
        let user = users.find(u => u.email === email);
        
        if (!user) {
            user = {
                id: users.length + 1,
                email,
                name,
                role
            };
            
            // Add role-specific fields
            if (role === 'student') {
                // Get student data from database
                const studentData = studentsDB.find(s => s.studentEmail === email);
                if (studentData) {
                    user.branchSection = studentData.branchSection;
                    user.parentEmail = studentData.parentEmail;
                } else {
                    user.branchSection = 'UNKNOWN';
                    user.parentEmail = process.env.PARENT_EMAIL;
                }
                user.roll = email.split('@')[0].toUpperCase();
            } else if (role === 'teacher') {
                // Get sections assigned to this teacher
                const sections = facultySectionsDB.filter(f => f.facultyEmail === email).map(f => f.branchSection);
                user.sections = sections;
            } else if (role === 'hod') {
                user.department = 'ALL';
            }
            
            users.push(user);
        }
        
        const authToken = jwt.sign({ id: user.id, email: user.email, role: user.role }, SECRET);
        res.json({ token: authToken, user });
    } catch (error) {
        res.status(401).json({ error: 'Invalid Google token' });
    }
});

// Student endpoints
app.post('/api/student/request', authenticate, async (req, res) => {
    const user = users.find(u => u.id === req.user.id);
    const { type, reason, date, time } = req.body;
    
    const request = {
        id: requestIdCounter++,
        student_id: user.id,
        student_name: user.name,
        student_roll: user.roll,
        student_branch_section: user.branchSection,
        request_type: type,
        reason,
        leave_date: date,
        leave_time: time,
        status: 'PENDING_PARENT',
        parent_status: 'pending',
        teacher_status: 'pending',
        hod_status: 'pending',
        submitted_at: new Date().toISOString(),
        parent_token: jwt.sign({ requestId: requestIdCounter - 1, type: 'parent' }, SECRET)
    };
    
    requests.push(request);
    
    // Send email to parent
    try {
        const parentEmail = user.parentEmail || process.env.PARENT_EMAIL;
        console.log('Attempting to send email...');
        console.log('From:', process.env.EMAIL_USER);
        console.log('To:', parentEmail);
        
        await resend.emails.send({
            from: `BVRITH <${process.env.EMAIL_USER}>`,
            to: parentEmail,
            subject: `Leave Request from ${user.name}`,
            html: `
                <h2>Student Leave Request</h2>
                <p><strong>Student:</strong> ${user.name} (${user.roll})</p>
                <p><strong>Type:</strong> ${type}</p>
                <p><strong>Date:</strong> ${date}</p>
                <p><strong>Time:</strong> ${time}</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <br>
                <a href="${BASE_URL}/login.html?token=${request.parent_token}" 
                   style="background:#27ae60;color:white;padding:12px 24px;text-decoration:none;border-radius:5px;">
                   Approve/Reject Request
                </a>
            `
        });
        console.log('✅ Email sent to parent:', parentEmail);
    } catch (emailError) {
        console.error('❌ Email failed:', emailError.message);
        console.error('Full error:', emailError);
        // Continue anyway - request is saved
    }
    
    res.json({ requestId: request.id, message: 'Request submitted' });
});

app.get('/api/student/requests', authenticate, (req, res) => {
    const userRequests = requests.filter(r => r.student_id === req.user.id);
    res.json(userRequests);
});

app.post('/api/student/cancel/:id', authenticate, (req, res) => {
    const request = requests.find(r => r.id === parseInt(req.params.id) && r.student_id === req.user.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    request.status = 'CANCELLED_BY_STUDENT';
    res.json({ message: 'Request cancelled' });
});

// Teacher endpoints
app.get('/api/teacher/requests/pending', authenticate, (req, res) => {
    const user = users.find(u => u.id === req.user.id);
    const pending = requests.filter(r => 
        r.status === 'PENDING_TEACHER' && 
        user.sections && user.sections.includes(r.student_branch_section)
    );
    res.json(pending);
});

app.post('/api/teacher/approve/:id', authenticate, (req, res) => {
    const request = requests.find(r => r.id === parseInt(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    request.teacher_status = 'approved';
    request.status = 'PENDING_HOD';
    request.teacher_approved_at = new Date().toISOString();
    res.json({ message: 'Request approved' });
});

app.post('/api/teacher/reject/:id', authenticate, (req, res) => {
    const request = requests.find(r => r.id === parseInt(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    request.teacher_status = 'rejected';
    request.status = 'REJECTED_BY_TEACHER';
    request.teacher_rejection_reason = req.body.reason;
    res.json({ message: 'Request rejected' });
});

// HOD endpoints
app.get('/api/hod/requests/pending', authenticate, (req, res) => {
    // HOD sees all pending requests
    const pending = requests.filter(r => r.status === 'PENDING_HOD');
    res.json(pending);
});

app.post('/api/hod/approve/:id', authenticate, (req, res) => {
    const request = requests.find(r => r.id === parseInt(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    request.hod_status = 'approved';
    request.status = 'APPROVED';
    request.hod_approved_at = new Date().toISOString();
    res.json({ message: 'Request approved' });
});

app.post('/api/hod/reject/:id', authenticate, (req, res) => {
    const request = requests.find(r => r.id === parseInt(req.params.id));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    request.hod_status = 'rejected';
    request.status = 'REJECTED_BY_HOD';
    request.hod_rejection_reason = req.body.reason;
    res.json({ message: 'Request rejected' });
});

// Parent endpoints
app.get('/api/parent/request/:token', (req, res) => {
    try {
        const decoded = jwt.verify(req.params.token, SECRET);
        const request = requests.find(r => r.id === decoded.requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        res.json(request);
    } catch (error) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

app.post('/api/parent/approve/:token', (req, res) => {
    try {
        const decoded = jwt.verify(req.params.token, SECRET);
        const request = requests.find(r => r.id === decoded.requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        
        request.parent_status = 'approved';
        request.status = 'PENDING_TEACHER';
        request.parent_approved_at = new Date().toISOString();
        res.json({ message: 'Request approved' });
    } catch (error) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

app.post('/api/parent/reject/:token', (req, res) => {
    try {
        const decoded = jwt.verify(req.params.token, SECRET);
        const request = requests.find(r => r.id === decoded.requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        
        request.parent_status = 'rejected';
        request.status = 'REJECTED_BY_PARENT';
        request.parent_rejection_reason = req.body.reason;
        res.json({ message: 'Request rejected' });
    } catch (error) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('\n✅ Email-based authentication enabled');
    console.log('Authorized domain: @bvrithyderabad.edu.in');
    console.log('Role detection:');
    console.log('  - *@hod.bvrithyderabad.edu.in → HOD');
    console.log('  - *wh*@bvrithyderabad.edu.in (first 10 chars) → Student');
    console.log('  - *@bvrithyderabad.edu.in → Teacher');
});
