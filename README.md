# Email Order Fetcher

Connects to your IMAP inbox, parses order emails, and lets you export a CSV for bulk upload.

## CSV Output Format
`S.No | Client Order Number | Street Address | Zipcode | Parcel Number | Service Code | Customer ID | Borrower Name | Delivery Email`

---

## Deploy to Render

1. Push this folder to a **GitHub repository**
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. Add **Environment Variables** (optional — you can also configure via the UI):

| Key | Value |
|-----|-------|
| `IMAP_HOST` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `IMAP_ENCRYPTION` | `ssl` |
| `IMAP_USER` | `orders@yourcompany.com` |
| `IMAP_PASS` | your app password |
| `IMAP_FOLDER` | `INBOX` |
| `DEFAULT_CUSTOMER_ID` | your customer ID |
| `DEFAULT_DELIVERY_EMAIL` | delivery email |

6. Deploy → visit your Render URL

---

## Local Development

```bash
npm install
cp .env.example .env   # fill in your credentials
node server.js
# open http://localhost:3000
```

---

## Usage

1. **Configure** — Enter IMAP credentials and click Save, then Test Connection
2. **Fetch** — Choose a date and click "Fetch New Emails" to pull unseen messages from your inbox for that day only.
3. **Review** — Edit any cell in the table (Customer ID, Parcel Number, Service Code, etc.)
4. **Download** — Click "Download CSV" to get the bulk-upload ready file

> ⚠️ **Important:** Orders live in memory. Download your CSV before restarting the server or it will be lost. On Render free tier the server sleeps after 15 minutes of inactivity and restarts fresh.

---

## Gmail Setup (App Password)

1. Enable 2FA on your Google account
2. Go to **Google Account → Security → App Passwords**
3. Create an app password for "Mail"
4. Use that 16-character password as `IMAP_PASS`
5. Set `IMAP_HOST=imap.gmail.com`, `IMAP_PORT=993`, `IMAP_ENCRYPTION=ssl`
