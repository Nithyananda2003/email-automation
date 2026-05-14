const puppeteer = require('puppeteer');

const BASE_URL = 'https://resware.trueconcepttitle.com';

const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--single-process',
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
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    '--js-flags=--max-old-space-size=256',
];

const BLOCKED_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'websocket', 'manifest', 'other']);

async function scrapeByFileNumbers(fileNumbers, username, password, directUrlMap = {}, onProgress) {
    console.log(`[TrueConcept] Starting lookup for ${fileNumbers.length} file number(s)...`);
    if (fileNumbers.length === 0) return [];

    const browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
    const results = [];

    try {
        // ── Login once ───────────────────────────────────────────────────────
        const loginPage = await browser.newPage();
        await loginPage.setViewport({ width: 1024, height: 768 });
        await loginPage.setRequestInterception(true);
        loginPage.on('request', req => BLOCKED_TYPES.has(req.resourceType()) ? req.abort() : req.continue());

        console.log(`[TrueConcept] Logging in as ${username}...`);
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
            if (!el) return null;
            const t = el.innerText.trim();
            return t.toLowerCase().includes('please log in') ? null : (t || null);
        });
        if (loginError) throw new Error(`TrueConcept login failed: ${loginError}`);
        console.log('[TrueConcept] Login successful.');
        await loginPage.close();

        // ── Process each file number using a fresh page per file ─────────────
        for (let i = 0; i < fileNumbers.length; i++) {
            const fileNumber = fileNumbers[i].trim();
            console.log(`[TrueConcept] Searching: ${fileNumber} (${i + 1}/${fileNumbers.length})`);
            if (onProgress) onProgress({ portal: 'TrueConcept/TrustPro', fileNumber, status: 'searching', index: i + 1, total: fileNumbers.length });

            const page = await browser.newPage();
            try {
                await page.setViewport({ width: 1024, height: 768 });
                await page.setRequestInterception(true);
                page.on('request', req => BLOCKED_TYPES.has(req.resourceType()) ? req.abort() : req.continue());
                await page.setCacheEnabled(false);

                const direct = directUrlMap[fileNumber];

                if (direct && direct.url) {
                    await page.goto(direct.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                } else {
                    await page.goto(`${BASE_URL}/AllFiles.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    const inp = await page.$('input[name="fn"]');
                    if (!inp) {
                        if (onProgress) onProgress({ portal: 'TrueConcept/TrustPro', fileNumber, status: 'skipped', reason: 'Search box not found' });
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
                    console.log(`[TrueConcept] ${fileNumber} not found — skipping.`);
                    if (onProgress) onProgress({ portal: 'TrueConcept/TrustPro', fileNumber, status: 'not_found' });
                    await page.close();
                    continue;
                }

                const details = await scrapeCurrentPage(page, fileNumber);
                results.push(details);
                console.log(`[TrueConcept] ✓ ${fileNumber}: ${details.streetAddress}`);
                if (onProgress) onProgress({ portal: 'TrueConcept/TrustPro', fileNumber, status: 'found', data: details });

            } catch (err) {
                console.error(`[TrueConcept] Error on ${fileNumber}:`, err.message);
                if (onProgress) onProgress({ portal: 'TrueConcept/TrustPro', fileNumber, status: 'error', reason: err.message });
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
    return results;
}

async function scrapeCurrentPage(page, fileNumber) {
    const details = await page.evaluate((fn) => {
        const tableRows = Array.from(document.querySelectorAll(
            'tr[style*="color:#000066"], tr.dataRow'
        )).filter(r => r.querySelectorAll('td.dataRow').length >= 2);

        let propertyAddress = '', buyerName = '', parcelNumber = '';

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
            }
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

        const fnUpper = fn.toUpperCase();
        const customerId = fnUpper.startsWith('TP') ? 'cus18' : 'cus42';

        const zipMatch = propertyAddress.match(/(\d{5})(?:-\d{4})?/);
        return {
            streetAddress: propertyAddress,
            zipcode:       zipMatch ? zipMatch[1] : '',
            parcelNumber,
            serviceCode:   mapServiceCode(productType),
            customerId,
            borrowerName:  buyerName,
            deliveryEmail: '',
        };
    }, fileNumber);
    return { clientOrderNumber: fileNumber, ...details };
}

module.exports = { scrapeByFileNumbers };
