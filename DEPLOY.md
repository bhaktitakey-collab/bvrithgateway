# Deploy to Render

## Step 1: Push to GitHub

1. Go to https://github.com/new
2. Create a new repository (e.g., "student-gateway")
3. Don't initialize with README

Then run these commands in your terminal:

```bash
cd ~/student-gateway-domain-auth
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/student-gateway.git
git push -u origin main
```

## Step 2: Deploy on Render

1. Go to https://render.com and sign up (free)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: student-gateway
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

5. Add Environment Variables (click "Advanced" → "Add Environment Variable"):
   ```
   GOOGLE_CLIENT_ID=254165822234-o2fh6as8an9ebe0qm9aea7r1rrpc1dgd.apps.googleusercontent.com
   EMAIL_USER=bhaktitakey@gmail.com
   EMAIL_PASS=wpazptqrvtxaedet
   PARENT_EMAIL=bhaktitakey@gmail.com
   BASE_URL=https://student-gateway.onrender.com
   ```
   (Replace the BASE_URL with your actual Render URL after deployment)

6. Click "Create Web Service"

## Step 3: Update Google OAuth

After deployment, you'll get a URL like: `https://student-gateway.onrender.com`

1. Go to https://console.cloud.google.com/
2. Go to APIs & Services → Credentials
3. Click your OAuth Client ID
4. Add to **Authorized JavaScript origins**:
   - `https://student-gateway.onrender.com`
5. Add to **Authorized redirect URIs**:
   - `https://student-gateway.onrender.com`
   - `https://student-gateway.onrender.com/login.html`
6. Save

## Step 4: Update BASE_URL

1. In Render dashboard, go to your service
2. Go to "Environment" tab
3. Update `BASE_URL` to your actual Render URL
4. Save (it will redeploy automatically)

## Done!

Your app will be live at: `https://student-gateway.onrender.com/login.html`

**Note**: Free tier sleeps after 15 minutes of inactivity. First request may take 30-60 seconds to wake up.
