require('dotenv').config();

const express           = require('express');
const { ImapFlow }      = require('imapflow');
const { simpleParser }  = require('mailparser');
const { parseOrderEmail } = require('./parser');
const { lookupFileNumbers, routeFileNumber } = require('./scrapers');
const ExcelJS           = require('exceljs');
const createCsvWriter   = require('csv-writer').createObjectCsvWriter;
const path              = require('path');
const fs                = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure downloads directory exists
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// ── In-memory state ──────────────────────────────────────────────────────────

let imapConfig = {
    host:                   process.env.IMAP_HOST                || '',
    port:                   parseInt(process.env.IMAP_PORT)      || 993,
    encryption:             process.env.IMAP_ENCRYPTION          || 'ssl',
    user:                   process.env.IMAP_USER                || '',
    pass:                   process.env.IMAP_PASS                || '',
    folder:                 process.env.IMAP_FOLDER              || 'INBOX',
    default_customer_id:    process.env.DEFAULT_CUSTOMER_ID      || '',
    default_delivery_email: process.env.DEFAULT_DELIVERY_EMAIL   || '',
};

let emailOrders  = [];   // Parsed email orders (file numbers + raw data)
let nextId       = 1;
let seenUids     = new Set();

// Portal lookup state (in-memory, real-time log)
let lookupRunning = false;
let lookupLog     = [];   // Array of progress events
let lookupResults = [];   // Final found records
let lastExcelName = '';
let lastCsvName   = '';

// ── IMAP Config API ──────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
    res.json({ ...imapConfig, pass: imapConfig.pass ? '••••••••' : '' });
});

app.post('/api/config', (req, res) => {
    const { host, port, encryption, user, pass, folder,
            default_customer_id, default_delivery_email } = req.body;
    imapConfig = {
        host:                   host                    || imapConfig.host,
        port:                   parseInt(port)          || imapConfig.port,
        encryption:             encryption              || imapConfig.encryption,
        user:                   user                    || imapConfig.user,
        pass:                   (pass && pass !== '••••••••') ? pass : imapConfig.pass,
        folder:                 folder                  || imapConfig.folder,
        default_customer_id:    default_customer_id     !== undefined ? default_customer_id    : imapConfig.default_customer_id,
        default_delivery_email: default_delivery_email  !== undefined ? default_delivery_email : imapConfig.default_delivery_email,
    };
    res.json({ success: true, message: 'Configuration saved.' });
});

// ── IMAP Helpers ─────────────────────────────────────────────────────────────

function buildImapClient(onError) {
    const client = new ImapFlow({
        host:   imapConfig.host,
        port:   imapConfig.port,
        secure: imapConfig.encryption === 'ssl',
        auth:   { user: imapConfig.user, pass: imapConfig.pass },
        tls:    { rejectUnauthorized: false },
        logger: false,
    });
    client.on('error', err => {
        console.error('IMAP client error:', err);
        if (typeof onError === 'function') onError(err);
    });
    return client;
}

function stripHtml(html) {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// ── Test Connection ───────────────────────────────────────────────────────────

app.post('/api/test-connection', async (req, res) => {
    if (!imapConfig.host || !imapConfig.user || !imapConfig.pass) {
        return res.json({ success: false, message: 'Please save IMAP credentials first.' });
    }
    let client;
    try {
        client = buildImapClient();
        await client.connect();
        const status = await client.status(imapConfig.folder || 'INBOX', { messages: true, unseen: true });
        await client.logout();
        res.json({
            success: true,
            message: `Connected! ${status.messages} total messages, ${status.unseen} unseen.`,
        });
    } catch (err) {
        try { if (client) await client.logout(); } catch (_) {}
        res.json({ success: false, message: 'Connection failed: ' + err.message });
    }
});

// ── Fetch & Parse Emails ──────────────────────────────────────────────────────

app.post('/api/fetch', async (req, res) => {
    if (!imapConfig.host || !imapConfig.user || !imapConfig.pass) {
        return res.json({ success: false, message: 'No IMAP configuration found. Please save settings first.' });
    }

    const { date } = req.body || {};
    let client;
    let clientError = null;
    const result = { success: true, fetched: 0, parsed: 0, skipped: 0, errors: [] };

    try {
        client = buildImapClient(err => { clientError = err; });
        await client.connect();
        if (clientError) throw clientError;

        const lock = await client.getMailboxLock(imapConfig.folder || 'INBOX');
        try {
            let searchQuery = { all: true };
            let dateInfo = '';

            if (date) {
                const chosenDate = new Date(date);
                if (!Number.isFinite(chosenDate.getTime())) {
                    await client.logout();
                    return res.json({ success: false, message: 'Invalid fetch date provided.' });
                }
                const nextDay = new Date(chosenDate);
                nextDay.setDate(nextDay.getDate() + 1);
                searchQuery.since  = chosenDate;
                searchQuery.before = nextDay;
                dateInfo = ` (${chosenDate.toDateString()})`;
            }

            console.log('[FETCH] Searching for emails' + dateInfo + '...');
            const uids = await client.search(searchQuery, { uid: true });

            if (!uids || uids.length === 0) {
                result.message = 'No emails found.';
                await client.logout();
                return res.json(result);
            }

            const freshUids = uids.filter(uid => !seenUids.has(uid));
            if (freshUids.length === 0) {
                result.message = 'All emails were already fetched this session.';
                result.skipped = uids.length;
                await client.logout();
                return res.json(result);
            }

            for await (const msg of client.fetch(freshUids, { source: true, uid: true }, { uid: true })) {
                result.fetched++;
                try {
                    const parsed_email = await simpleParser(msg.source);
                    const subject = parsed_email.subject || '';
                    const body    = parsed_email.text || (parsed_email.html ? stripHtml(parsed_email.html) : '');
                    const data    = parseOrderEmail(subject, body);

                    const row = {
                        id:                  null,
                        sno:                 emailOrders.length + 1,
                        client_order_number: data.file_number    || '',
                        street_address:      data.street_address || '',
                        zipcode:             data.zipcode        || '',
                        parcel_number:       '',
                        service_code:        data.service_code   || '',
                        customer_id:         data.customer_id || imapConfig.default_customer_id || '',
                        borrower_name:       data.borrower_name  || '',
                        delivery_email:      imapConfig.default_delivery_email || '',
                        // Extra context
                        _subject:        subject,
                        _from:           parsed_email.from?.text || '',
                        _company:        data.company_name || '',
                        _city:           data.city    || '',
                        _state:          data.state   || '',
                        _county:         data.county  || '',
                        _product:        data.product || '',
                        _uid:            msg.uid,
                        _portal:         routeFileNumber(data.file_number || ''),
                        _portal_file_id: data.portal_file_id || '', // direct FileID from email link
                        _portal_url:     data.portal_url     || '', // direct FileDetails URL
                    };

                    if (!row.client_order_number) {
                        result.errors.push(`UID ${msg.uid} skipped: no file number extracted`);
                        result.skipped++;
                        seenUids.add(msg.uid);
                    } else {
                        row.id = nextId++;
                        emailOrders.push(row);
                        seenUids.add(msg.uid);
                        result.parsed++;
                    }
                } catch (parseErr) {
                    result.errors.push(`UID ${msg.uid}: ${parseErr.message}`);
                }
            }

            emailOrders.forEach((o, i) => { o.sno = i + 1; });

        } finally {
            lock.release();
        }

        await client.logout();
        result.message = `Fetched ${result.fetched} email(s), parsed ${result.parsed} order(s).`;
        res.json(result);

    } catch (err) {
        try { if (client) await client.logout(); } catch (_) {}
        result.success = false;
        result.message = err.message;
        result.errors.push(err.message);
        res.json(result);
    }
});

// ── Email Orders CRUD ─────────────────────────────────────────────────────────

app.get('/api/orders', (_req, res) => res.json(emailOrders));

app.put('/api/orders/:id', (req, res) => {
    const id  = parseInt(req.params.id);
    const idx = emailOrders.findIndex(o => o.id === id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Order not found.' });
    emailOrders[idx] = { ...emailOrders[idx], ...req.body, id };
    res.json({ success: true, order: emailOrders[idx] });
});

app.delete('/api/orders/:id', (req, res) => {
    const id = parseInt(req.params.id);
    emailOrders = emailOrders.filter(o => o.id !== id);
    emailOrders.forEach((o, i) => { o.sno = i + 1; });
    res.json({ success: true });
});

app.delete('/api/orders', (_req, res) => {
    emailOrders = [];
    nextId = 1;
    seenUids.clear();
    res.json({ success: true, message: 'All orders cleared.' });
});

// ── Email CSV Download (raw email parse output) ───────────────────────────────

app.get('/api/download-csv', (req, res) => {
    const headers = ['S.No','Client Order Number','Street Address','Zipcode','Parcel Number','Service Code','Customer ID','Borrower Name','Delivery Email'];
    const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows    = [
        headers.map(escape).join(','),
        ...emailOrders.map(o => [o.sno, o.client_order_number, o.street_address, o.zipcode, o.parcel_number, o.service_code, o.customer_id, o.borrower_name, o.delivery_email].map(escape).join(','))
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="email_orders_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('\uFEFF' + rows.join('\r\n'));
});

// ── Portal Lookup ─────────────────────────────────────────────────────────────

/**
 * POST /api/portal-lookup
 * Triggers portal lookup for all currently fetched email file numbers.
 * Progress is streamed via SSE at /api/portal-lookup/progress.
 */

// SSE clients for progress streaming
let sseClients = [];

app.get('/api/portal-lookup/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send existing log immediately (catch up)
    for (const event of lookupLog) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    sseClients.push(res);
    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

function broadcastProgress(event) {
    lookupLog.push(event);
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch (_) {}
    }
}

app.post('/api/portal-lookup', async (req, res) => {
    if (lookupRunning) {
        return res.json({ success: false, message: 'A portal lookup is already running.' });
    }

    const fileNumbers = emailOrders
        .map(o => o.client_order_number)
        .filter(Boolean);

    if (fileNumbers.length === 0) {
        return res.json({ success: false, message: 'No file numbers found. Please fetch emails first.' });
    }

    // Reset state
    lookupRunning = true;
    lookupLog     = [];
    lookupResults = [];
    lastExcelName = '';
    lastCsvName   = '';

    // Respond immediately — results come via SSE
    res.json({ success: true, message: `Starting portal lookup for ${fileNumbers.length} file number(s)…`, count: fileNumbers.length });

    // Build a map of fileNumber -> direct portal info (FileID/URL) from email orders
    const directUrlMap = {};
    for (const o of emailOrders) {
        if (o.client_order_number && o._portal_file_id) {
            directUrlMap[o.client_order_number] = {
                fileId: o._portal_file_id,
                url:    o._portal_url,
            };
        }
    }

    // Run in background
    (async () => {
        try {
            broadcastProgress({ type: 'start', total: fileNumbers.length, fileNumbers });

            const results = await lookupFileNumbers(fileNumbers, directUrlMap, (event) => {
                broadcastProgress({ type: 'progress', ...event });
            });

            lookupResults = results;

            // Save files
            if (results.length > 0) {
                const ts = Date.now();
                const excelName = `portal_lookup_${ts}.xlsx`;
                const csvName   = `portal_lookup_${ts}.csv`;
                lastExcelName   = excelName;
                lastCsvName     = csvName;

                await saveToExcel(results, path.join(downloadDir, excelName));
                await saveToCsv(results,   path.join(downloadDir, csvName));

                broadcastProgress({ type: 'done', found: results.length, excel: excelName, csv: csvName });
            } else {
                broadcastProgress({ type: 'done', found: 0, excel: null, csv: null });
            }

        } catch (err) {
            console.error('[PortalLookup] Fatal error:', err.message);
            broadcastProgress({ type: 'error', message: err.message });
        } finally {
            lookupRunning = false;
        }
    })();
});

app.get('/api/portal-lookup/results', (_req, res) => {
    res.json({
        running: lookupRunning,
        results: lookupResults,
        excel:   lastExcelName,
        csv:     lastCsvName,
    });
});

// ── File Download ─────────────────────────────────────────────────────────────

app.get('/download/:filename', (req, res) => {
    const fp = path.join(downloadDir, path.basename(req.params.filename));
    if (fs.existsSync(fp)) {
        res.download(fp);
    } else {
        res.status(404).send('File not found');
    }
});

app.get('/api/downloads', (_req, res) => {
    if (!fs.existsSync(downloadDir)) return res.json([]);
    const files = fs.readdirSync(downloadDir)
        .filter(f => f.endsWith('.xlsx') || f.endsWith('.csv'))
        .map(f => ({ name: f, time: fs.statSync(path.join(downloadDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 20);
    res.json(files);
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (_req, res) => {
    const incomplete = emailOrders.filter(o => !o.client_order_number || !o.street_address || !o.service_code || !o.customer_id).length;
    res.json({ total: emailOrders.length, incomplete, complete: emailOrders.length - incomplete });
});

// ── Excel / CSV Helpers ───────────────────────────────────────────────────────

const COLUMNS = [
    { header: 'S.No',                key: 'sNo' },
    { header: 'Client Order Number', key: 'clientOrderNumber' },
    { header: 'Street Address',      key: 'streetAddress' },
    { header: 'Zipcode',             key: 'zipcode' },
    { header: 'Parcel Number',       key: 'parcelNumber' },
    { header: 'Service Code',        key: 'serviceCode' },
    { header: 'Customer ID',         key: 'customerId' },
    { header: 'Borrower Name',       key: 'borrowerName' },
    { header: 'Delivery Email',      key: 'deliveryEmail' },
];

async function saveToExcel(data, filepath) {
    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Portal Orders');
    worksheet.columns = COLUMNS;
    worksheet.getRow(1).font = { bold: true };
    data.forEach((row, i) => worksheet.addRow({ sNo: i + 1, ...row }));
    await workbook.xlsx.writeFile(filepath);
}

async function saveToCsv(data, filepath) {
    const writer = createCsvWriter({
        path: filepath,
        header: COLUMNS.map(c => ({ id: c.key, title: c.header })),
    });
    await writer.writeRecords(data.map((row, i) => ({ sNo: i + 1, ...row })));
}

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
    console.log(`\n🚀 Email-to-Portal Automation running at http://localhost:${PORT}\n`);
});
server.timeout = 600000; // 10 minutes for long scraping tasks
