const puppeteer = require('puppeteer');

const BASE_URL = 'https://rwportal.ca-svs.com';

// Memory-optimized Puppeteer args
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',          // Use /tmp instead of /dev/shm
    '--disable-gpu',
    '--no-zygote',
    '--single-process',                  // Run everything in one process (saves ~100MB)
    '--no-first-run',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees,site-per-process',
    '--disable-ipc-flooding-protection',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    '--js-flags=--max-old-space-size=256', // Cap JS heap at 256MB
];

const BLOCKED_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'websocket', 'manifest', 'other']);

async function scrapeByFileNumbers(fileNumbers, username, password, directUrlMap = {}, onProgress) {
    console.log(`[Cypress] Starting lookup for ${fileNumbers.length} file number(s)...`);
    if (fileNumbers.length === 0) return [];

    const browser = await puppeteer.launch({
        headless: true,
        args: PUPPETEER_ARGS,
    });

    const results = [];

    try {
        // ── Login once ───────────────────────────────────────────────────────
        const loginPage = await browser.newPage();
        await loginPage.setViewport({ width: 1024, height: 768 });
        await loginPage.setRequestInterception(true);
        loginPage.on('request', req => BLOCKED_TYPES.has(req.resourceType()) ? req.abort() : req.continue());

        console.log(`[Cypress] Logging in as ${username}...`);
        await loginPage.goto(`${BASE_URL}/Home.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await loginPage.waitForSelector('#ctl00_ContentPlaceHolder1_tbUsername', { timeout: 15000 });
        await loginPage.type('#ctl00_ContentPlaceHolder1_tbUsername', username, { delay: 30 });
        await loginPage.type('#ctl00_ContentPlaceHolder1_tbPassword', password, { delay: 30 });
        await Promise.all([
            loginPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            loginPage.click('#ctl00_ContentPlaceHolder1_Button1')
        ]);

        const loginError = await loginPage.evaluate(() => {
            const el = document.querySelector('#ctl00_ContentPlaceHolder1_lErrorMessage');
            return el ? el.innerText.trim() : null;
        });
        if (loginError) throw new Error(`Cypress login failed: ${loginError}`);
        console.log('[Cypress] Login successful.');
        await loginPage.close(); // Free login page memory immediately

        // ── Process each file number using a fresh page per file ─────────────
        for (let i = 0; i < fileNumbers.length; i++) {
            const fileNumber = fileNumbers[i].trim();
            console.log(`[Cypress] Searching: ${fileNumber} (${i + 1}/${fileNumbers.length})`);
            if (onProgress) onProgress({ portal: 'Cypress', fileNumber, status: 'searching', index: i + 1, total: fileNumbers.length });

            const page = await browser.newPage();
            try {
                await page.setViewport({ width: 1024, height: 768 });
                await page.setRequestInterception(true);
                page.on('request', req => BLOCKED_TYPES.has(req.resourceType()) ? req.abort() : req.continue());
                await page.setCacheEnabled(false);

                const direct = directUrlMap[fileNumber];

                if (direct && direct.url) {
                    // Strategy A: direct URL from email link
                    await page.goto(direct.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                } else {
                    // Strategy B: Find File search form
                    await page.goto(`${BASE_URL}/AllFiles.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    const inp = await page.$('input[name="fn"]');
                    if (!inp) {
                        if (onProgress) onProgress({ portal: 'Cypress', fileNumber, status: 'skipped', reason: 'Search box not found' });
                        await page.close();
                        continue;
                    }
                    await inp.click({ clickCount: 3 });
                    await inp.type(fileNumber, { delay: 20 });
                    await page.evaluate(() => {
                        const el = document.querySelector('input[name="fn"]');
                        if (!el) return;
                        let sib = el.nextElementSibling;
                        while (sib) {
                            if (sib.tagName === 'INPUT' && (sib.type === 'submit' || sib.value === 'Go')) { sib.click(); return; }
                            sib = sib.nextElementSibling;
                        }
                        el.closest('form')?.submit();
                    });
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                }

                const currentUrl = page.url();
                if (!currentUrl.toLowerCase().includes('filedetails')) {
                    console.log(`[Cypress] ${fileNumber} not found — skipping.`);
                    if (onProgress) onProgress({ portal: 'Cypress', fileNumber, status: 'not_found' });
                    await page.close();
                    continue;
                }

                const details = await scrapeCurrentPage(page, fileNumber);
                results.push(details);
                console.log(`[Cypress] ✓ ${fileNumber}: ${details.streetAddress}`);
                if (onProgress) onProgress({ portal: 'Cypress', fileNumber, status: 'found', data: details });

            } catch (err) {
                console.error(`[Cypress] Error on ${fileNumber}:`, err.message);
                if (onProgress) onProgress({ portal: 'Cypress', fileNumber, status: 'error', reason: err.message });
            } finally {
                await page.close(); // Always close page to free memory
            }
        }
    } finally {
        await browser.close();
    }
    return results;
}

async function scrapeCurrentPage(page, fileNumber) {
    const details = await page.evaluate(() => {
        const tableRows = Array.from(document.querySelectorAll(
            'tr[style*="color:#000066"], tr.dataRow'
        )).filter(r => r.querySelectorAll('td.dataRow').length >= 2);

        let propertyAddress = '', buyerName = '', parcelNumber = '', clientName = '';

        for (const row of tableRows) {
            const cells = Array.from(row.querySelectorAll('td.dataRow'));
            if (cells.length < 2) continue;
            const type = cells[0].innerText.trim().toLowerCase();
            if (type === 'property') {
                propertyAddress = (cells[2] ? cells[2].innerText : cells[1].innerText).trim();
            } else if (type === 'buyer' || type === 'borrower') {
                buyerName = cells[1].innerText.trim();
            } else if (type.includes('parcel')) {
                parcelNumber = cells[1].innerText.trim();
            } else if (type === 'client' || type === 'lender') {
                clientName = cells[1].innerText.trim();
            }
        }
        if (!clientName) {
            const el = document.querySelector('#ctl00_ContentPlaceHolder1_lClientName');
            if (el) clientName = el.innerText.trim();
        }

        const actionTypeEl = document.querySelector('#ctl00_ContentPlaceHolder1_lActionType');
        const productType = actionTypeEl ? actionTypeEl.innerText.trim() : '';

        const mapServiceCode = pt => {
            if (!pt) return 'cos';
            const p = pt.toLowerCase();
            if (p.includes('legal & vesting') || p.includes('legal &amp; vesting')) return 'CLV';
            if (p.includes('purchase')) return 'fs';
            return 'cos';
        };

        const CLIENT_MAP = {
            'accurate group':'cus44','fhcunv':'cus35','bal':'cus11','paramount':'cus6',
            'cypress':'cus25','david kottmann':'cus26','david olson':'cus24',
            'elevated title':'cus1','elite':'cus15','ip':'cus4',
            'investors title & settlement':'cus19','rose ramirez':'cus29','nax':'cus8',
            'member close':'cus43','navy federal':'cus45','nwres':'cus5','ocls':'cus17',
            'ort':'cus14','priority titleus':'cus16','rocket close':'cus20','tc':'cus2',
            'ted smith atl':'cus41','true concept title':'cus42','trustpro title':'cus18',
            'tv rvsi':'cus12','ures':'cus22','vpt':'cus13',
        };
        const mapCustomerId = cn => {
            if (!cn) return 'cus25';
            const lower = cn.toLowerCase().trim();
            if (CLIENT_MAP[lower]) return CLIENT_MAP[lower];
            for (const [k, v] of Object.entries(CLIENT_MAP)) {
                if (lower.includes(k) || k.includes(lower)) return v;
            }
            return 'cus25';
        };

        const zipMatch = propertyAddress.match(/(\d{5})(?:-\d{4})?/);
        return {
            streetAddress: propertyAddress,
            zipcode:       zipMatch ? zipMatch[1] : '',
            parcelNumber,
            serviceCode:   mapServiceCode(productType),
            customerId:    mapCustomerId(clientName),
            borrowerName:  buyerName,
            deliveryEmail: '',
        };
    });
    return { clientOrderNumber: fileNumber, ...details };
}

module.exports = { scrapeByFileNumbers };
