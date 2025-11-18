# Voice Agent WebSocket Server

This is a standalone WebSocket server for handling real-time voice AI calls with Twilio Media Streams.

## Deploy to Railway

### Option 1: Deploy from GitHub (Recommended)

1. **Push this folder to a GitHub repository**
   ```bash
   cd railway-websocket
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin YOUR_GITHUB_REPO_URL
   git push -u origin main
   ```

2. **Deploy on Railway**
   - Go to https://railway.app
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect the Node.js project

3. **Add Environment Variables**
   In Railway project settings, add:
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key
   - `PORT` - Will be set automatically by Railway

4. **Get your Railway URL**
   - After deployment, Railway will provide a URL like: `https://your-app.up.railway.app`
   - Copy this URL

5. **Update Twilio Webhook**
   In your Twilio webhook function, change the WebSocket URL to:
   ```
   wss://your-app.up.railway.app?agent_id=${agentId}&call_sid=${CallSid}
   ```

### Option 2: Deploy with Railway CLI

1. **Install Railway CLI**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login and deploy**
   ```bash
   cd railway-websocket
   railway login
   railway init
   railway up
   ```

3. **Add environment variables**
   ```bash
   railway variables set SUPABASE_URL=your_supabase_url
   railway variables set SUPABASE_SERVICE_ROLE_KEY=your_service_key
   ```

4. **Get the URL**
   ```bash
   railway domain
   ```

## Deploy to Render

1. **Create a new Web Service** on https://render.com
2. Connect your GitHub repository
3. Configure:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Add environment variables in Render dashboard
5. Deploy and copy the provided URL

## Local Testing

```bash
cd railway-websocket
npm install
# Create .env file with your environment variables
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
PORT=3000

npm start
```

Server will run on `http://localhost:3000`

## Update Twilio Webhook

After deployment, update the `twilio-webhook` edge function in Supabase to use your new Railway/Render URL:

```typescript
const websocketUrl = `wss://your-railway-app.up.railway.app?agent_id=${agentId}&call_sid=${CallSid}`;
```
