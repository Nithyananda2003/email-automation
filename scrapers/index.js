const rwportal = require('./rwportal');
const trusro   = require('./trusro');

const CYPRESS_CREDS  = { username: 'Sachin.D@invictolabs.com', password: 'Invictolabs@2025' };
const TRUSRO_CREDS   = { username: 'jp@invictolabs.com',       password: 'Postive@2021' };

function routeFileNumber(fileNumber) {
    const fn = (fileNumber || '').trim().toUpperCase();
    if (fn.startsWith('TP') || fn.startsWith('T')) return 'trusro';
    return 'rwportal';
}

/**
 * @param {string[]} fileNumbers
 * @param {Object}   directUrlMap  { fileNumber: { fileId, url } }  from email links
 * @param {function} onProgress
 */
async function lookupFileNumbers(fileNumbers, directUrlMap = {}, onProgress) {
    const cypressFiles = fileNumbers.filter(fn => routeFileNumber(fn) === 'rwportal');
    const trusroFiles  = fileNumbers.filter(fn => routeFileNumber(fn) === 'trusro');

    console.log(`[Scrapers] Routing: ${cypressFiles.length} → Cypress, ${trusroFiles.length} → TrueConcept/TrustPro`);

    const allResults = [];

    if (cypressFiles.length > 0) {
        const res = await rwportal.scrapeByFileNumbers(
            cypressFiles, CYPRESS_CREDS.username, CYPRESS_CREDS.password, directUrlMap, onProgress
        );
        allResults.push(...res);
    }

    if (trusroFiles.length > 0) {
        const res = await trusro.scrapeByFileNumbers(
            trusroFiles, TRUSRO_CREDS.username, TRUSRO_CREDS.password, directUrlMap, onProgress
        );
        allResults.push(...res);
    }

    return allResults;
}

module.exports = { lookupFileNumbers, routeFileNumber };
