# eMortgage 200-Point Leaderboard

Live leaderboard pulling dials from VICIdial and SF data (transfers, soft pulls, apps out).
- **Salesforce** refreshes every 60 seconds
- **VICIdial** refreshes every 10 minutes

---

## Deploy to Railway (5 minutes)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_ORG/emortgage-leaderboard.git
git push -u origin main
```

### 2. Create Railway project
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select `emortgage-leaderboard`
3. Railway auto-detects Node.js and runs `npm start`

### 3. Add environment variables in Railway
Go to your service → Variables tab → add these:

| Variable | Value |
|---|---|
| SF_URL | https://emtg.my.salesforce.com |
| SF_CLIENT_ID | Your Connected App Client ID |
| SF_CLIENT_SECRET | Your Connected App Client Secret |
| SF_USERNAME | mustafa@emtg.com |
| SF_PASSWORD | yourpassword + security token (no space) |
| VICI_BASE | https://emortgage.talkitpro.com |
| VICI_USER | your vicidial admin username |
| VICI_PASS | your vicidial admin password |

### 4. Get your URL
Railway gives you a URL like `https://emortgage-leaderboard.up.railway.app`

Optionally add a custom domain: Railway → Settings → Custom Domain → `leaderboard.emtg.com`

---

## Embed in Salesforce (2 minutes)

1. Go to **Setup → Lightning App Builder**
2. Open your Home Page (or create a new App Page)
3. Drag a **"Web Content"** (or "Visualforce/HTML") standard component onto the page
4. Set the URL to: `https://your-railway-url.up.railway.app`
5. Set height to `700px`
6. Save & Activate

That's it — managers see the leaderboard right inside Salesforce.

---

## TV / Floor display

Just open the Railway URL in Chrome on your floor TV browser.
- Full-screen with F11
- It auto-refreshes — no interaction needed
- Works on any device: phone, tablet, laptop, TV

---

## Salesforce Connected App setup

If you don't have one already:
1. SF Setup → App Manager → New Connected App
2. Enable OAuth, add scopes: `api`, `refresh_token`
3. Callback URL: `https://login.salesforce.com/services/oauth2/success`
4. Save → copy Consumer Key (Client ID) and Consumer Secret

---

## How scoring works

| Action | Points |
|---|---|
| 1 dial | 1 pt |
| 1 transfer picked up | 10 pts |
| 1 app out (imbus__Initial_Disclosure_Date__c = today) | 100 pts |
| Every 3 soft pulls (Date_of_Soft_Pull__c = today) | 100 pts |
| **Daily goal** | **200 pts** |

Point values are editable in the UI — click "Edit values".

---

## Data sources

| Metric | Object | Logic |
|---|---|---|
| Dials | VICIdial agent performance report | Calls column, grouped by user |
| Transfers | Lead | Dialer_Agent__c != null AND Owner != TalkItPro/VDAD, CreatedDate = TODAY |
| Soft pulls | Lead | Date_of_Soft_Pull__c = TODAY, grouped by Dialer_Agent__c |
| Apps out | Opportunity | imbus__Initial_Disclosure_Date__c = TODAY, grouped by Owner.Name |
