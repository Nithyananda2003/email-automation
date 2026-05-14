/**
 * parser.js
 * Parses order emails into structured data.
 * Ported from Email_order_lib.php
 *
 * Subject format:
 *   PA-151413: 1035 King Road, Harborcreek, PA 16421-1344: Michael Klingensmith: Property Search Report for Erie County
 *
 * Body contains:
 *   File Number, Borrowers, Property Address, Product / Requirements
 */

function cleanFileNumber(fn) {
    if (!fn) return '';
    // Strip any trailing URL in angle brackets e.g. "CT-152190<https://...>"
    fn = fn.replace(/<https?:\/\/[^>]*>/g, '').trim();
    // Strip any trailing URL without brackets
    fn = fn.replace(/\s+https?:\/\/\S+/g, '').trim();
    return fn;
}

function extractPortalUrls(body) {
    // Find FileDetails.aspx URLs in email body (plain text or angle-bracket links)
    const urls = {};
    const re = /<?(https?:\/\/[^>\s]*FileDetails\.aspx\?FileID=(\d+))[>\s]?/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        const fileId = m[2];
        const url = m[1];
        urls[fileId] = url;
    }
    return urls; // { fileId: url }
}

function parseOrderEmail(subject, body) {
    const parsed = {
        file_number:    '',
        borrower_name:  '',
        street_address: '',
        city:           '',
        state:          '',
        zipcode:        '',
        county:         '',
        product:        '',
        service_code:   '',
        company_name:   '',
        customer_id:    '',
        portal_file_id: '',   // direct FileID if found in email link
        portal_url:     '',   // full direct URL to FileDetails page
    };

    // ── Subject parsing ──────────────────────────────────────────────────────
    subject = (subject || '').trim();
    let remaining = subject;

    // Extract leading file number  e.g. "PA-151413: "
    const fileMatch = subject.match(/^([A-Za-z]{1,4}-\d+|\S+-\d+)\s*:\s*/i);
    if (fileMatch) {
        parsed.file_number = fileMatch[1].trim();
        remaining = subject.substring(fileMatch[0].length);
    }

    const parts = remaining.split(':');

    if (parts.length >= 2) {
        // Part 0 → address  "1035 King Road, Harborcreek, PA 16421-1344"
        const addrMatch = parts[0].trim().match(
            /^(.+?),\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i
        );
        if (addrMatch) {
            parsed.street_address = addrMatch[1].trim();
            parsed.city           = addrMatch[2].trim();
            parsed.state          = addrMatch[3].trim().toUpperCase();
            parsed.zipcode        = addrMatch[4].trim().substring(0, 5);
        }

        // Part 1 → borrower and service/county
        const svcPart = parts.slice(1).join(':').trim();
        const borrowerMatch = svcPart.match(/^(.+?)\s+(?:Property Search Report Request|Property Search Report|Search Report)\s+(?:for|in)\s+(.+?)(?:\s+County)?\s*$/i);
        if (borrowerMatch) {
            parsed.borrower_name = borrowerMatch[1].trim();
            parsed.county        = borrowerMatch[2].trim().replace(/County/gi, '').trim();
            parsed.service_code  = 'Property Search Report';
        } else {
            // Fallback: assume the whole is borrower
            parsed.borrower_name = svcPart;
        }
    }

    // ── Body parsing ─────────────────────────────────────────────────────────
    const b = (body || '').replace(/\r/g, '');

    // File Number (overrides subject if found) — clean any trailing URL
    const fnMatch = b.match(
        /(?:File\s*(?:Number|#|No\.?)|Order\s*No|Loan\s*No)\s*:\s*(.+?)(?:\n|$)/i
    );
    if (fnMatch && fnMatch[1].trim()) {
        parsed.file_number = cleanFileNumber(fnMatch[1]);
    } else {
        // Also clean subject-extracted file number
        parsed.file_number = cleanFileNumber(parsed.file_number);
    }

    // Extract direct portal FileDetails URLs from the email body
    const portalUrls = extractPortalUrls(b);
    // If body has a FileDetails URL for a known portal, grab the first one
    const firstUrl = Object.values(portalUrls)[0];
    if (firstUrl) {
        const idMatch = firstUrl.match(/FileID=(\d+)/i);
        parsed.portal_file_id = idMatch ? idMatch[1] : '';
        parsed.portal_url     = firstUrl;
    }

    // Borrower Name
    const bnMatch = b.match(/Borrower(?:s?|(?:\s*Name))\s*:?\s*([^\n]+)/i);
    if (bnMatch) {
        let bn = bnMatch[1].trim();
        if (bn.includes(':')) {
            const bParts = bn.split(':').map(s => s.trim()).filter(Boolean);
            bn = bParts[bParts.length - 1];
        }
        bn = bn.replace(/[.,;]+$/, '');
        if (bn && bn.length > 2) parsed.borrower_name = bn;
    }

    // Property Address
    const propMatch = b.match(
        /Property(?:\s*Address)?\s*:\s*(.+?)(?:\n\n|\n(?=[A-Z])|$)/
    );
    if (propMatch) {
        const prop = propMatch[1].trim();
        if (prop) {
            const propPatterns = [
                /^(.+?),\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i,
                /^(.+?),\s*([^,]+?),\s*([A-Z]{2})\s*-\s*(\d{5}(?:-\d{4})?)\s*$/i,
                /^(.+)\s+([^,]+),\s*([A-Z]{2})\s*-\s*(\d{5}(?:-\d{4})?)\s*$/i,
                /^(.+)\s+([^,]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i,
            ];
            let matched = false;
            for (const pattern of propPatterns) {
                const m = prop.match(pattern);
                if (m) {
                    parsed.street_address = prop.trim();
                    parsed.city           = m[2].trim();
                    parsed.state          = m[3].trim().toUpperCase();
                    parsed.zipcode        = m[4].trim().substring(0, 5);
                    matched = true;
                    break;
                }
            }
            // Fallback: just grab state + zip and split the rest
            if (!matched) {
                const fb = prop.match(/^(.+?),?\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i);
                if (fb) {
                    const prefix = fb[1].trim();
                    parsed.state   = fb[2].trim().toUpperCase();
                    parsed.zipcode = fb[3].trim().substring(0, 5);
                    if (prefix.includes(',')) {
                        const pp = prefix.split(',').map(s => s.trim());
                        parsed.city           = pp.pop();
                        parsed.street_address = pp.join(', ');
                    } else {
                        // Last word cluster → city
                        const pp2 = prefix.match(/^(.+?)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})$/);
                        if (pp2) {
                            parsed.street_address = pp2[1].trim();
                            parsed.city           = pp2[2].trim();
                        } else {
                            parsed.street_address = prefix;
                        }
                    }
                } else {
                    // If no pattern matches, take the whole property as street address
                    parsed.street_address = prop.trim();
                }
            }
        }
    }

    // Product
    const prodMatch = b.match(/(?:Product|Vendor\s*Product)\s*:\s*(.+?)(?:\n|$)/i);
    if (prodMatch) parsed.product = prodMatch[1].trim();

    // Service code — opening sentence, then Requirements block
    if (!parsed.service_code) {
        parsed.service_code = extractServiceFromOpening(b) || extractServiceFromBody(b) || '';
    }

    // Override service from body if found
    const bodyService = extractServiceFromOpening(b) || extractServiceFromBody(b);
    if (bodyService) {
        parsed.service_code = bodyService;
    }

    // Company Name and Customer ID lookup
    const companyMatch = b.match(/(?:Company|Agent|Title\s+Company|Closing\s+Agent)\s*:?\s*([^\n]+)/i);
    if (companyMatch) {
        parsed.company_name = companyMatch[1].trim();
        parsed.customer_id = findCustomerIdByName(parsed.company_name) || '';
    }

    // Clean county
    parsed.county = parsed.county.replace(/County/gi, '').trim();

    return parsed;
}

// ── Customer Lookup ─────────────────────────────────────────────────────────

const CUSTOMER_LOOKUP = {
    'accurate group':                 'cus44',
    'fhcunv':                         'cus35',
    'bal':                            'cus11',
    'paramount':                      'cus6',
    'cypress':                        'cus25',
    'david kottmann':                 'cus26',
    'david olson':                    'cus24',
    'demotest for tax':               'cus31',
    'elevated title':                 'cus1',
    'elite':                          'cus15',
    'ip':                             'cus4',
    'investors title & settlement services, inc.':  'cus19',
    'investors title & settlement':   'cus19',
    'rose ramirez & associates, p.c.':'cus29',
    'rose ramirez':                   'cus29',
    'nax':                            'cus8',
    'member close':                   'cus43',
    'navy federal credit union':      'cus45',
    'nwres':                          'cus5',
    'ocls':                           'cus17',
    'ort':                            'cus14',
    'priority titleus':               'cus16',
    'rocket close':                   'cus20',
    'tc':                             'cus2',
    'ted smith atl':                  'cus41',
    'cu test':                        'cus33',
    'dtms sp2':                       'cus10',
    'true concept title':             'cus42',
    'trustpro title':                 'cus18',
    'tv rvsi':                        'cus12',
    'ures':                           'cus22',
    'vpt':                            'cus13',
};

function findCustomerIdByName(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    
    // Try exact matches first
    if (CUSTOMER_LOOKUP[lower]) return CUSTOMER_LOOKUP[lower];
    
    // Try partial matches
    for (const [name, id] of Object.entries(CUSTOMER_LOOKUP)) {
        if (lower.includes(name) || name.includes(lower)) {
            return id;
        }
    }
    
    return null;
}

// ── Service Map ──────────────────────────────────────────────────────────────
const SERVICE_MAP = {
    // Type codes
    'type1':                          'type1',
    '1004sf':                         '1004SF',
    '1025mf':                         '1025MF',
    '1073c':                          '1073C',
    '2055db':                         '2055DB',
    '2055dbuad':                      '2055DBUAD',
    
    // Search services
    'aes':                            'aes',
    'ae search':                      'aes',
    'aim2':                           'aim2',
    'assignment verification':        'av',
    'av':                             'AV',
    'ceri':                           'CERI',
    'commercial evaluation':          'CERI',
    'commercial full search':         'cfs',
    'current owner search':           'cosl',
    'current owner':                  'cosl',
    'owner search':                   'cosl',
    '1 owner':                        'type1',
    'one owner':                      'type1',
    'two owner search':               'tos',
    'data entry':                     'DE',
    'de':                             'DE',
    'deed/legal':                     'dlvs',
    'deed search':                    'dlvs',
    'legal vesting':                  'CLV',
    'legal description':              'CLV',
    'vesting':                        'CLV',
    'document retrieval':             'dr',
    'full search':                    'fs',
    'fs':                             'fs',
    'home builder':                   'hb',
    'judgement search':               'js',
    'judgment search':                'js',
    'land evaluation commercial':     'LEC',
    'land evaluation residential':    'LER',
    'mobile home search':             'MHS',
    'policy production':              'Pop',
    'postclose':                      'Postc',
    'property condition report':      'PCP',
    'property report':                'CPR',
    'property valuation':             'PVM',
    'qualia commitment':              'qualia-commitment',
    'recording':                      'Recording',
    'residential evaluation exterior':'RERE',
    'residential evaluation interior':'RERI',
    'search fix':                     'sf',
    'sir current owner':              'SIRCOS',
    'sir legal vesting':              'SIRLV',
    'sir updates':                    'SIRUpd',
    'tax cert':                       'TC',
    'taxes':                          'TC',
    'typing module':                  'tm1',
    'typing c/o':                     'tm1',
    'typing fs':                      'tm3',
    'typing l&v':                     'tm2',
    'updates/bring downs':            'ubd',
    
    // Legacy mappings (for backward compatibility)
    'title search':                   'fs',
    'property search':                'fs',
    'hoa search':                     'cosl',
    'homeowners association':         'cosl',
    'liens':                          'dlvs',
    'lien search':                    'dlvs',
    'open liens':                     'dlvs',
    'mortgage':                       'CPR',
    'environmental':                  'EU',
    'survey':                         'CPR',
};

function mapService(text) {
    const lower = text.toLowerCase();
    for (const [key, val] of Object.entries(SERVICE_MAP)) {
        if (lower.includes(key)) return val;
    }
    return text;
}

function findServiceInText(text) {
    const lower = text.toLowerCase();
    const entries = Object.entries(SERVICE_MAP).sort((a, b) => b[0].length - a[0].length);
    for (const [keyword, service] of entries) {
        const escapedKey = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let matches = false;
        if (keyword.includes(' ')) {
            matches = lower.includes(keyword);
        } else {
            const regex = new RegExp('\\b' + escapedKey + '\\b', 'i');
            matches = regex.test(lower);
        }
        if (matches) {
            return service;
        }
    }
    return null;
}

function extractServiceFromOpening(body) {
    const opening = body.substring(0, 500);
    const m = opening.match(
        /(?:provide|request|need|search for|i need|submit)\s+(?:a\s+)?(.+?)(?:\s+for\s+(?:the|60|\d+)|\.|\n)/i
    );
    if (m) {
        let svc = m[1].trim().replace(/\s+/g, ' ').trim();
        return findServiceInText(svc);
    }
    return null;
}

function extractServiceFromBody(body) {
    const req = body.toLowerCase();
    return findServiceInText(req);
}

module.exports = { parseOrderEmail };
