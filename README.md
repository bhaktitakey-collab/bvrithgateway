# Student Gateway - Domain-Based Authentication

## Setup

### 1. Get Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable **Google+ API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized JavaScript origins: `http://localhost:3000`
7. Copy the **Client ID**

### 2. Configure Environment

Edit `.env`:
```bash
GOOGLE_CLIENT_ID=254165822234-o2fh6as8an9ebe0qm9aea7r1rrpc1dgd.apps.googleusercontent.com
EMAIL_USER=bhaktitakey@gmail.com
EMAIL_PASS=wpazptqrvtxaedet
PARENT_EMAIL=bhaktitakey@gmail.com
```

Edit `login.html` line 62:
```javascript
const GOOGLE_CLIENT_ID = '254165822234-o2fh6as8an9ebe0qm9aea7r1rrpc1dgd.apps.googleusercontent.com';
```

### 3. Configure Domain Mapping

Edit `server.js` lines 16-21 to match your university domains:
```javascript
const DOMAIN_ROLES = {
    'student.university.edu': 'student',
    'faculty.university.edu': 'teacher',
    'teacher.university.edu': 'teacher',
    'hod.university.edu': 'hod'
};
```

### 4. Install & Run

```bash
npm install
npm start
```

Open `login.html` in browser.

## How It Works

1. User clicks "Sign in with Google"
2. Google OAuth popup appears
3. User selects their university email
4. Server extracts email domain
5. Domain is mapped to role (student/teacher/hod)
6. User is auto-created and redirected to appropriate dashboard

## Domain Examples

- `john@student.university.edu` → Student Dashboard
- `jane@faculty.university.edu` → Teacher Dashboard
- `dr.smith@hod.university.edu` → HOD Dashboard
- `john@gmail.com` → Access Denied

## Next Steps

- Copy dashboard HTML files from your existing `gateway` folder
- Update API calls to use the token from localStorage
- Test with real university email domains
