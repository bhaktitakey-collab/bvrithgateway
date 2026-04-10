const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const twilio = require('twilio');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
console.log('Using Google Client ID:', GOOGLE_CLIENT_ID);

// Resend setup (parent emails)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Twilio setup (parent WhatsApp)
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

// Brevo (teacher/HOD emails)
async function sendBrevoEmail(to, subject, html) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sender: { name: 'BVRITH', email: process.env.EMAIL_USER },
            to: [{ email: to }],
            subject,
            htmlContent: html
        })
    });
    if (!res.ok) throw new Error(await res.text());
}

// --- DB helpers ---
function loadJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const STUDENTS_FILE = './new_students.json';
const SECTION_CONFIG_FILE = './new_section_config.json';
const REQUESTS_FILE = './new_leave_requests.json';
const WHATSAPP_LOG_FILE = './new_whatsapp_log.json';

// --- Role detection from section_config.json ---
function getRole(email) {
    const config = loadJSON(SECTION_CONFIG_FILE);

    const firstYearHod = config.first_year.hod;
    const deptHods = Object.values(config.departments).map(d => d.hod);
    const allHods = [firstYearHod, ...deptHods];

    const firstYearTeachers = Object.values(config.first_year.batches)
        .flatMap(batch => Object.values(batch).map(s => s.class_teacher));
    const deptTeachers = Object.values(config.departments)
        .flatMap(d => Object.values(d.batches)
            .flatMap(batch => Object.values(batch).map(s => s.class_teacher)));
    const allTeachers = [...new Set([...firstYearTeachers, ...deptTeachers])];

    if (allHods.includes(email)) return 'hod';
    if (allTeachers.includes(email)) return 'teacher';

    const students = loadJSON(STUDENTS_FILE);
    if (students.find(s => s.email === email)) return 'student';

    return null;
}

// --- Student config lookup ---
function getStudentConfig(student) {
    const config = loadJSON(SECTION_CONFIG_FILE);
    const admissionYear = parseInt(student.batch.split('-')[0]);
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1; // 1-12
    // Academic year starts in July, so before July still in same academic year
    const academicYear = currentMonth >= 7 ? currentYear : currentYear - 1;
    const yearOfStudy = academicYear - admissionYear + 1;

    if (yearOfStudy === 1) {
        const section = config.first_year.batches[student.batch][student.section];
        return { hod: config.first_year.hod, class_teacher: section.class_teacher };
    } else {
        const dept = config.departments[student.department];
        return { hod: dept.hod, class_teacher: dept.batches[student.batch][student.section].class_teacher };
    }
}

// --- Request ID generator ---
function generateRequestId() {
    const requests = loadJSON(REQUESTS_FILE);
    return `REQ${String(requests.length + 1).padStart(3, '0')}`;
}

// --- WhatsApp log ---
function logWhatsApp(requestId, phone, messageType, status) {
    const logs = loadJSON(WHATSAPP_LOG_FILE);
    logs.push({
        log_id: `LOG${String(logs.length + 1).padStart(3, '0')}`,
        request_id: requestId,
        phone,
        message_type: messageType,
        sent_at: new Date().toISOString(),
        delivery_status: status
    });
    saveJSON(WHATSAPP_LOG_FILE, logs);
}

// --- Auth middleware ---
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// --- Google OAuth login ---
app.post('/api/auth/google', async (req, res) => {
    try {
        const { token } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const { email, name } = ticket.getPayload();

        const role = getRole(email);
        if (!role) return res.status(403).json({ error: 'Email not authorized.' });

        let userData = { email, name, role };

        if (role === 'student') {
            const student = loadJSON(STUDENTS_FILE).find(s => s.email === email);
            userData = { ...userData, ...student };
            const snapshot = getStudentConfig(student);
            userData.class_teacher = snapshot.class_teacher;
            userData.hod = snapshot.hod;
        } else if (role === 'teacher') {
            const config = loadJSON(SECTION_CONFIG_FILE);
            // Find all sections this teacher is assigned to
            const sections = [];
            Object.entries(config.first_year.batches).forEach(([batch, secs]) => {
                Object.entries(secs).forEach(([sec, val]) => {
                    if (val.class_teacher === email) sections.push({ batch, section: sec, type: 'first_year' });
                });
            });
            Object.entries(config.departments).forEach(([dept, deptVal]) => {
                Object.entries(deptVal.batches).forEach(([batch, secs]) => {
                    Object.entries(secs).forEach(([sec, val]) => {
                        if (val.class_teacher === email) sections.push({ batch, section: sec, dept, type: 'dept' });
                    });
                });
            });
            userData.sections = sections;
        } else if (role === 'hod') {
            const config = loadJSON(SECTION_CONFIG_FILE);
            // Find which dept/first_year this HOD manages
            const depts = [];
            if (config.first_year.hod === email) depts.push('first_year');
            Object.entries(config.departments).forEach(([dept, val]) => {
                if (val.hod === email) depts.push(dept);
            });
            userData.manages = depts;
        }

        const authToken = jwt.sign(userData, SECRET, { expiresIn: '8h' });
        res.json({ token: authToken, user: userData });
    } catch (error) {
        console.error('Google token error:', error.message);
        res.status(401).json({ error: 'Invalid Google token', detail: error.message });
    }
});

// --- Student: submit request ---
app.post('/api/student/request', authenticate, async (req, res) => {
    const { reason, from_date, to_date, time } = req.body;
    if (!reason || !from_date || !to_date) return res.status(400).json({ error: 'Fill all fields' });

    const student = loadJSON(STUDENTS_FILE).find(s => s.email === req.user.email);
    if (!student) return res.status(403).json({ error: 'Student not found' });

    const requests = loadJSON(REQUESTS_FILE);

    // One request per day
    const overlap = requests.find(r =>
        r.student_email === req.user.email &&
        r.from_date === from_date &&
        r.final_status !== 'cancelled'
    );
    if (overlap) return res.status(400).json({ error: 'You already have a request for this date.' });

    const snapshot = getStudentConfig(student);
    const requestId = generateRequestId();
    const parentToken = jwt.sign({ requestId, type: 'parent' }, SECRET);

    const request = {
        request_id: requestId,
        student_email: student.email,
        student_name: student.name,
        student_rollno: student.rollno,
        student_section: student.section,
        submitted_at: new Date().toISOString(),
        from_date,
        to_date,
        time: time || '',
        reason,
        snapshot,
        parent_token: parentToken,
        parent_status: 'pending',
        parent_responded_at: null,
        teacher_status: 'pending',
        teacher_remarks: null,
        teacher_actioned_at: null,
        hod_status: 'pending',
        hod_remarks: null,
        hod_actioned_at: null,
        final_status: 'pending'
    };

    requests.push(request);
    saveJSON(REQUESTS_FILE, requests);

    // WhatsApp to parent
    try {
        if (twilioClient && student.parent_phone) {
            await twilioClient.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to: `whatsapp:+${student.parent_phone}`,
                body: `Leave Request from ${student.name}\nDate: ${from_date}\nTime: ${time}\nReason: ${reason}\n\nApprove/Reject: ${BASE_URL}/login.html?token=${parentToken}`
            });
            logWhatsApp(requestId, student.parent_phone, 'approval_request', 'sent');
            console.log('✅ WhatsApp sent to parent:', student.parent_phone);
        }
    } catch (e) {
        logWhatsApp(requestId, student.parent_phone, 'approval_request', 'failed');
        console.error('❌ WhatsApp failed:', e.message);
    }

    res.json({ request_id: requestId, message: 'Request submitted' });
});

// --- Student: get requests ---
app.get('/api/student/requests', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    res.json(requests.filter(r => r.student_email === req.user.email));
});

// --- Student: cancel request ---
app.post('/api/student/cancel/:id', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const request = requests.find(r => r.request_id === req.params.id && r.student_email === req.user.email);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    request.final_status = 'cancelled';
    saveJSON(REQUESTS_FILE, requests);
    res.json({ message: 'Request cancelled' });
});

// --- Parent: get request ---
app.get('/api/parent/request/:token', (req, res) => {
    try {
        const { requestId } = jwt.verify(req.params.token, SECRET);
        const request = loadJSON(REQUESTS_FILE).find(r => r.request_id === requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        res.json(request);
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

// --- Parent: approve ---
app.post('/api/parent/approve/:token', async (req, res) => {
    try {
        const { requestId } = jwt.verify(req.params.token, SECRET);
        const requests = loadJSON(REQUESTS_FILE);
        const request = requests.find(r => r.request_id === requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });

        request.parent_status = 'approved';
        request.parent_responded_at = new Date().toISOString();
        saveJSON(REQUESTS_FILE, requests);

        // Notify teacher via Resend
        try {
            if (resend) {
                const pendingCount = requests.filter(r => r.snapshot.class_teacher === request.snapshot.class_teacher && r.parent_status === 'approved' && r.teacher_status === 'pending').length;
                await resend.emails.send({
                    from: 'BVRITH <onboarding@resend.dev>',
                    to: request.snapshot.class_teacher,
                    subject: `New Leave Request - ${pendingCount} request(s) pending`,
                    html: `<p>Leave request from <strong>${request.student_name}</strong> needs your approval.</p><p>You have <strong>${pendingCount}</strong> pending request(s).</p><p><a href="${BASE_URL}/login.html">Open Dashboard</a></p>`
                });
                console.log('✅ Teacher email sent:', request.snapshot.class_teacher);
            }
        } catch (e) { console.error('Teacher email failed:', e.message); }

        res.json({ message: 'Approved' });
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

// --- Parent: reject ---
app.post('/api/parent/reject/:token', (req, res) => {
    try {
        const { requestId } = jwt.verify(req.params.token, SECRET);
        const requests = loadJSON(REQUESTS_FILE);
        const request = requests.find(r => r.request_id === requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });

        request.parent_status = 'rejected';
        request.parent_responded_at = new Date().toISOString();
        request.final_status = 'rejected';
        saveJSON(REQUESTS_FILE, requests);
        res.json({ message: 'Rejected' });
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

// --- Teacher: get pending requests ---
app.get('/api/teacher/requests/pending', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const pending = requests.filter(r =>
        r.snapshot.class_teacher === req.user.email &&
        r.parent_status === 'approved' &&
        r.teacher_status === 'pending' &&
        r.final_status === 'pending'
    );
    res.json(pending);
});

// --- Teacher: approve ---
app.post('/api/teacher/approve/:id', authenticate, async (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const request = requests.find(r => r.request_id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    request.teacher_status = 'approved';
    request.teacher_remarks = req.body.remarks || null;
    request.teacher_actioned_at = new Date().toISOString();
    saveJSON(REQUESTS_FILE, requests);

    // Notify HOD via Brevo
    try {
        if (process.env.BREVO_API_KEY) {
            const pendingCount = requests.filter(r => r.snapshot.hod === request.snapshot.hod && r.teacher_status === 'approved' && r.hod_status === 'pending').length;
            await sendBrevoEmail(request.snapshot.hod,
                `New Leave Request - ${pendingCount} request(s) pending`,
                `<p>Leave request from <strong>${request.student_name}</strong> needs your approval.</p><p>You have <strong>${pendingCount}</strong> pending request(s).</p><p><a href="${BASE_URL}/login.html">Open Dashboard</a></p>`
            );
            console.log('✅ HOD email sent:', request.snapshot.hod);
        }
    } catch (e) { console.error('HOD email failed:', e.message); }

    res.json({ message: 'Approved' });
});

// --- Teacher: reject ---
app.post('/api/teacher/reject/:id', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const request = requests.find(r => r.request_id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    request.teacher_status = 'rejected';
    request.teacher_remarks = req.body.reason || null;
    request.teacher_actioned_at = new Date().toISOString();
    request.final_status = 'rejected';
    saveJSON(REQUESTS_FILE, requests);
    res.json({ message: 'Rejected' });
});

// --- HOD: get pending requests ---
app.get('/api/hod/requests/pending', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const pending = requests.filter(r =>
        r.snapshot.hod === req.user.email &&
        r.teacher_status === 'approved' &&
        r.hod_status === 'pending' &&
        r.final_status === 'pending'
    );
    res.json(pending);
});

// --- HOD: approve ---
app.post('/api/hod/approve/:id', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const request = requests.find(r => r.request_id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    request.hod_status = 'approved';
    request.hod_remarks = req.body.remarks || null;
    request.hod_actioned_at = new Date().toISOString();
    request.final_status = 'approved';
    saveJSON(REQUESTS_FILE, requests);
    res.json({ message: 'Approved' });
});

// --- HOD: reject ---
app.post('/api/hod/reject/:id', authenticate, (req, res) => {
    const requests = loadJSON(REQUESTS_FILE);
    const request = requests.find(r => r.request_id === req.params.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    request.hod_status = 'rejected';
    request.hod_remarks = req.body.reason || null;
    request.hod_actioned_at = new Date().toISOString();
    request.final_status = 'rejected';
    saveJSON(REQUESTS_FILE, requests);
    res.json({ message: 'Rejected' });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log('✅ New database structure active');
});
