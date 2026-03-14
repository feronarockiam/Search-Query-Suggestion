/**
 * ACS Suggestions Index Generator (Phase 3)
 *
 * NEW IN PHASE 3:
 * 1. N-gram frequency mining from product names — no manual whitelist needed.
 *    "almond", "training", "ragi" are discovered automatically if they appear
 *    in >= MIN_NGRAM_FREQ products.
 * 2. Contextual combos with demographics — "sleeveless for boys", "almond oil
 *    for baby", "diapers for newborn" — mined from actual product catalog data.
 * 3. keyword_combo type: keyword × product_type cross-reference suggestions.
 * 4. Two-pass architecture: first collect all products, then run global analysis.
 */

const algoliasearch = require('algoliasearch');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

// ─── Config ───────────────────────────────────────────────────────────────────

const {
    ALGOLIA_APP_ID,
    ALGOLIA_WRITE_KEY,
    ALGOLIA_INDEX_NAME,
    ALGOLIA_SUGGESTION_INDEX
} = {
    ALGOLIA_APP_ID: (process.env.ALGOLIA_APP_ID || '').trim(),
    ALGOLIA_WRITE_KEY: (process.env.ALGOLIA_WRITE_KEY || '').trim(),
    ALGOLIA_INDEX_NAME: (process.env.ALGOLIA_INDEX_NAME || '').trim(),
    ALGOLIA_SUGGESTION_INDEX: (process.env.ALGOLIA_SUGGESTION_INDEX || '').trim()
};

if (!ALGOLIA_APP_ID || !ALGOLIA_WRITE_KEY || !ALGOLIA_INDEX_NAME || !ALGOLIA_SUGGESTION_INDEX) {
    console.error('Missing Algolia credentials in .env');
    process.exit(1);
}

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_WRITE_KEY);
const productIndex = client.initIndex(ALGOLIA_INDEX_NAME);
const suggestionIndex = client.initIndex(ALGOLIA_SUGGESTION_INDEX);

// Min products a term must appear in to qualify as a suggestion
const MIN_NGRAM_FREQ = 5;
// Min products a contextual combo must appear in
const MIN_COMBO_FREQ = 2;
// Max brand_ptype combos need at least this many products
const MIN_BRAND_PTYPE_PRODUCTS = 3;

// ─── Stop Words (excluded from n-gram mining) ─────────────────────────────────

const STOP_WORDS = new Set([
    // English function words
    'the', 'and', 'with', 'for', 'of', 'in', 'a', 'is', 'to', 'your', 'our', 'pack', 'set',
    'this', 'that', 'these', 'those', 'from', 'has', 'have', 'are', 'was', 'were', 'will',
    'been', 'be', 'an', 'on', 'at', 'by', 'or', 'as', 'if', 'so', 'do', 'not', 'no', 'but',
    'can', 'all', 'use', 'also', 'new', 'best', 'good', 'get', 'its', 'may', 'per', 'via',
    'each', 'any', 'both', 'into', 'over', 'than', 'then', 'when', 'just', 'very', 'more',
    // Units / size words
    'kg', 'ml', 'gm', 'ltr', 'litre', 'liter', 'pcs', 'piece', 'pieces', 'count', 'counts',
    'months', 'month', 'years', 'year', 'days', 'day', 'old', 'age',
    'size', 'small', 'large', 'medium', 'extra', 'mini', 'micro', 'nano',
    'xl', 'xxl', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    // Noise words common in product names
    'baby', 'babies', 'kids', 'child', 'children', 'infant', 'toddler',
    'pack', 'packs', 'combo', 'value', 'bundle', 'assorted', 'variety',
    'free', 'plus', 'pro', 'max', 'ultra', 'super', 'mega', 'premium', 'deluxe',
    'care', 'love', 'soft', 'pure', 'safe', 'gentle', 'mild', 'fresh',
    'made', 'india', 'brand', 'certified', 'approved', 'tested', 'recommended',
    'buy', 'online', 'offer', 'sale', 'discount', 'deal',
]);

// ─── Demographic Patterns (for contextual combos) ─────────────────────────────

const DEMOGRAPHIC_PATTERNS = [
    { regex: /\b(for\s+boys?|boy)\b/i, tag: 'for boys' },
    { regex: /\b(for\s+girls?|girl)\b/i, tag: 'for girls' },
    { regex: /\b(newborn|new\s*born)\b/i, tag: 'for newborn' },
    { regex: /\b(infant|infants)\b/i, tag: 'for infant' },
    { regex: /\b(toddler|toddlers)\b/i, tag: 'for toddler' },
    { regex: /\b(0-3\s*months?|0\s*to\s*3\s*months?)\b/i, tag: '0-3 months' },
    { regex: /\b(3-6\s*months?|3\s*to\s*6\s*months?)\b/i, tag: '3-6 months' },
    { regex: /\b(6-12\s*months?|6\s*to\s*12\s*months?)\b/i, tag: '6-12 months' },
    { regex: /\b(1-2\s*years?|1\s*to\s*2\s*years?)\b/i, tag: '1-2 years' },
    { regex: /\b(2-3\s*years?|2\s*to\s*3\s*years?)\b/i, tag: '2-3 years' },
    { regex: /\b(3-5\s*years?)\b/i, tag: '3-5 years' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

let synonymMap = {};
try {
    const rawSynonyms = JSON.parse(fs.readFileSync('./synonyms.json', 'utf8'));
    rawSynonyms.forEach(group => {
        if (group.synonyms && group.synonyms.length > 1) {
            const standard = group.synonyms[0];
            group.synonyms.forEach(syn => { synonymMap[syn.toLowerCase()] = standard; });
        }
    });
    console.log(`Loaded ${Object.keys(synonymMap).length} synonym mappings.`);
} catch (_) {
    console.warn('synonyms.json not loaded.');
}

let brandCompactSet = new Set();   // populated after pass 1 to exclude from n-gram mining
const generateHash = text => crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex');

const normalizeValue = val => {
    if (!val) return { original: null, normalized: null };
    const clean = val.toString().trim();
    return { original: clean, normalized: synonymMap[clean.toLowerCase()] || clean };
};

const isValidSuggestion = (text, skipped) => {
    if (!text) { skipped.missing++; return false; }
    if (text.length > 30) { skipped.too_long++; return false; }
    if (/[&,]| - /.test(text)) { skipped.bad_char++; return false; }
    return true;
};

const cleanText = text => text
    ? text.replace(/\//g, ' ').replace(/&/g, ' ').replace(/,/g, ' ')
        .replace(/\s-\s/g, ' ').replace(/^-+|-+$/g, '').replace(/\s+/g, ' ').trim()
    : '';

const soundex = s => {
    if (!s) return '';
    const f = s.toLowerCase().charAt(0);
    const codes = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
    let r = '', last = codes[f];
    for (const char of s.toLowerCase().slice(1)) {
        const code = codes[char];
        if (code && code !== last) { r += code; last = code; }
        else if (!'aeiouyhw'.includes(char)) { last = null; }
    }
    return (f + r).padEnd(4, '0').slice(0, 4).toUpperCase();
};

const extractAttributes = name => {
    const a = [];
    const m = (r, k) => { const x = name?.match(r); if (x) a.push({ type: k, value: x[0] }); };
    m(/\b(size\s?\d+|newborn|nb)\b/i, 'size');
    m(/\b(stage\s?\d+|step\s?\d+)\b/i, 'stage');
    m(/\b(\d+-\d+\s?kg)\b/i, 'weight');
    m(/\b(\d+\s?pack|pack\s?of\s?\d+|\d+\s?pcs)\b/i, 'count');
    m(/\b(premium|active|ultra|natural|organic|soft|gentle)\b/i, 'variant');
    return a;
};

/**
 * Tokenize a product name into individual words for frequency analysis.
 * Returns only truly meaningful tokens (min length 4, not a stop word, not a number).
 */
function tokenizeName(name) {
    if (!name) return [];
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')   // strip punctuation
        .split(/\s+/)
        .filter(w => (
            w.length >= 4 &&
            !STOP_WORDS.has(w) &&
            !/^\d+$/.test(w)              // skip pure numbers
        ));
}

/**
 * Extract demographic tags found in a product name.
 */
function extractDemographics(name) {
    if (!name) return [];
    const found = [];
    for (const dp of DEMOGRAPHIC_PATTERNS) {
        if (dp.regex.test(name)) found.push(dp.tag);
    }
    return found;
}

// ─── Main Generator ───────────────────────────────────────────────────────────

async function generateRefinedSuggestions() {
    console.log('--- ACS Phase 3 Generation Started ---');
    const startTime = Date.now();

    const suggestions = new Map();   // key → record
    let productCount = 0;
    const skipped = { too_long: 0, missing: 0, bad_char: 0 };
    const typeCounts = {
        brand_only: 0, ptype_only: 0, brand_ptype: 0,
        brand_attribute: 0, keyword: 0, keyword_combo: 0, contextual: 0
    };

    // ───────────────────────────────────────────────────────────────────────────
    // GLOBAL ACCUMULATORS (for Pass 2 analysis)
    // ───────────────────────────────────────────────────────────────────────────
    const ngramFreq = new Map();           // word → number of unique products it appears in
    const ngramProducts = new Map();       // word → Set(product brand+ptype) for context
    const ngramProductStock = new Map();   // word → total stock (for popularity)
    const ngramProductCount = new Map();   // word → product count

    // word → { image, maxStock } for representative image selection
    const ngramBestImage = new Map();
    // "kw|demo" → { image, maxStock }
    const keywordDemoBestImage = new Map();
    // "kw|ptype" → { image, maxStock }
    const keywordPtypeBestImage = new Map();
    // "ptype|demo" → { image, maxStock }
    const ptypeDemoBestImage = new Map();

    const keywordDemoFreq = new Map();
    const keywordPtypeFreq = new Map();
    const ptypeDemoFreq = new Map();

    // Collect all raw products for pass 2 context building
    const allProducts = [];   // lightweight: { brand, ptype, name, stock, image, category }

    // ───────────────────────────────────────────────────────────────────────────
    // PASS 1: Browse all products — extract structured suggestions + accumulate 
    //         data for pass 2 analysis
    // ───────────────────────────────────────────────────────────────────────────

    const addOrUpdate = (text, type, data, extraStock = 0, image = null) => {
        if (!isValidSuggestion(text, skipped)) return;
        const key = text.toLowerCase();
        if (!suggestions.has(key)) {
            suggestions.set(key, {
                objectID: generateHash(key),
                suggestion: text,
                type,
                brand_name: data.brand || null,
                product_type: data.ptype || null,
                category_name: data.category || null,
                product_count: 0,
                popularity_score: 0,
                representative_image: image,
                has_variants: false,
                max_stock_found: -1,
                searchable_text: [text, data.brand || '', data.ptype || ''].filter(Boolean)
            });
        }
        const rec = suggestions.get(key);
        rec.product_count += 1;
        rec.popularity_score += extraStock;
        if (extraStock > rec.max_stock_found) {
            rec.max_stock_found = extraStock;
            if (image) rec.representative_image = image;
        }
        if (data.hasVariants) rec.has_variants = true;
    };

    try {
        await productIndex.browseObjects({
            attributesToRetrieve: ['brand_name', 'product_type', 'name', 'description', 'variants', 'available_stock', 'image', 'category_name'],
            batch: batch => {
                productCount += batch.length;
                batch.forEach(product => {
                    const brand = (product.brand_name || '').trim();
                    const ptypeInfo = normalizeValue(product.product_type);
                    const ptype = ptypeInfo.normalized;
                    const name = (product.name || '');
                    const desc = (product.description || '');
                    const category = product.category_name;

                    const stock = (product.variants || []).reduce(
                        (sum, v) => sum + (v.available_stock || 0),
                        product.available_stock || 0
                    );
                    const hasVariants = (product.variants && product.variants.length > 1);

                    const rawImage = product.image || (product.variants?.[0]?.image);
                    const image = rawImage ? (rawImage.startsWith('http') ? rawImage : `https://d14xdfvauagpvz.cloudfront.net/product/${rawImage}`) : null;

                    allProducts.push({ brand, ptype, name, desc, stock, image, category, hasVariants });

                    // — Structured suggestions (unchanged from Phase 1) —
                    if (brand) addOrUpdate(brand, 'brand_only', { brand, category }, stock, image);
                    if (ptype) addOrUpdate(ptype, 'ptype_only', { ptype, category }, stock, image);
                    if (brand && ptype) addOrUpdate(`${brand} ${ptype}`, 'brand_ptype', { brand, ptype, category, hasVariants }, stock, image);

                    extractAttributes(name).forEach(attr => {
                        if (brand) addOrUpdate(`${brand} ${attr.value}`, 'brand_attribute', { brand, category }, stock, image);
                    });

                    // — N-gram accumulation —
                    const nameText = cleanText(name + ' ' + desc);
                    const tokens = tokenizeName(nameText);
                    const seenInThisProduct = new Set();
                    tokens.forEach(w => {
                        if (seenInThisProduct.has(w)) return;   // count each product once per word
                        seenInThisProduct.add(w);
                        ngramFreq.set(w, (ngramFreq.get(w) || 0) + 1);
                        ngramProductCount.set(w, (ngramProductCount.get(w) || 0) + 1);
                        ngramProductStock.set(w, (ngramProductStock.get(w) || 0) + stock);
                        if (!ngramProducts.has(w)) ngramProducts.set(w, new Set());
                        if (ptype) ngramProducts.get(w).add(ptype);

                        // Image tracking for n-grams
                        const best = ngramBestImage.get(w);
                        if (!best || stock > best.maxStock) {
                            ngramBestImage.set(w, { image, maxStock: stock });
                        }
                    });

                    // — keyword × demographic accumulation —
                    const demographics = extractDemographics(name);
                    tokens.forEach(kw => {
                        demographics.forEach(demo => {
                            const key = `${kw}|${demo}`;
                            keywordDemoFreq.set(key, (keywordDemoFreq.get(key) || 0) + 1);

                            const best = keywordDemoBestImage.get(key);
                            if (!best || stock > best.maxStock) {
                                keywordDemoBestImage.set(key, { image, maxStock: stock });
                            }
                        });
                        if (ptype) {
                            const kpKey = `${kw}|${ptype}`;
                            keywordPtypeFreq.set(kpKey, (keywordPtypeFreq.get(kpKey) || 0) + 1);

                            const best = keywordPtypeBestImage.get(kpKey);
                            if (!best || stock > best.maxStock) {
                                keywordPtypeBestImage.set(kpKey, { image, maxStock: stock });
                            }
                        }
                    });

                    // — ptype × demographic accumulation —
                    if (ptype) {
                        demographics.forEach(demo => {
                            const key = `${ptype}|${demo}`;
                            ptypeDemoFreq.set(key, (ptypeDemoFreq.get(key) || 0) + 1);

                            const best = ptypeDemoBestImage.get(key);
                            if (!best || stock > best.maxStock) {
                                ptypeDemoBestImage.set(key, { image, maxStock: stock });
                            }
                        });
                    }
                });
            }
        });
    } catch (err) {
        console.error('Error during Pass 1:', err);
        process.exit(1);
    }

    console.log(`Pass 1 complete: ${productCount} products, ${suggestions.size} raw suggestions.`);

    // ───────────────────────────────────────────────────────────────────────────
    // PASS 2: Global Analysis — n-gram keywords + contextual combos
    // ───────────────────────────────────────────────────────────────────────────

    // Build brand exclusion set (don't turn brand names into keywords)
    const brandNamesLower = new Set(
        allProducts.map(p => p.brand.toLowerCase()).filter(Boolean)
    );
    // Also load brand_dictionary compact forms if available
    try {
        const dict = JSON.parse(fs.readFileSync('./brand_dictionary.json', 'utf8'));
        dict.brands.forEach(b => {
            if (b.compact) brandNamesLower.add(b.compact);
            if (b.normalized) brandNamesLower.add(b.normalized);
        });
    } catch (_) { }

    console.log(`Pass 2: Analyzing ${ngramFreq.size} unique tokens...`);

    // 2A. Keyword suggestions from n-gram frequency
    let kCount = 0;
    for (const [word, freq] of ngramFreq) {
        if (freq < MIN_NGRAM_FREQ) continue;
        if (brandNamesLower.has(word)) continue;
        if (STOP_WORDS.has(word)) continue;

        const stock = ngramProductStock.get(word) || 0;
        const prodCount = ngramProductCount.get(word) || 0;
        const bestImg = ngramBestImage.get(word)?.image || null;

        addOrUpdate(word, 'keyword', { ptype: null }, stock, bestImg);
        const rec = suggestions.get(word);
        if (rec) {
            rec.product_count = prodCount;
            rec.popularity_score = stock;
        }
        kCount++;
    }
    console.log(`  → ${kCount} keyword n-grams qualify (freq >= ${MIN_NGRAM_FREQ})`);

    // 2B. Contextual combos: keyword × product_type (e.g. "almond oil", "sleeveless shirt")
    let kcCount = 0;
    for (const [key, freq] of keywordPtypeFreq) {
        if (freq < MIN_COMBO_FREQ) continue;
        const [kw, pt] = key.split('|');
        if (!kw || !pt || kw === pt) continue;
        if (brandNamesLower.has(kw)) continue;
        if (!ngramFreq.has(kw) || (ngramFreq.get(kw) < MIN_NGRAM_FREQ)) continue;

        const combo = `${kw} ${pt}`;
        if (combo.length > 30) continue;
        const bestImg = keywordPtypeBestImage.get(key)?.image || null;
        addOrUpdate(combo, 'keyword_combo', { ptype: pt }, ngramProductStock.get(kw) || 0, bestImg);
        kcCount++;
    }
    console.log(`  → ${kcCount} keyword_combo suggestions`);

    // 2C. Contextual combos: keyword × demographic (e.g. "sleeveless for boys")
    let ctxCount = 0;
    for (const [key, freq] of keywordDemoFreq) {
        if (freq < MIN_COMBO_FREQ) continue;
        const [kw, demo] = key.split('|');
        if (!kw || !demo) continue;
        if (brandNamesLower.has(kw)) continue;
        if (!ngramFreq.has(kw) || (ngramFreq.get(kw) < MIN_NGRAM_FREQ)) continue;

        const combo = `${kw} ${demo}`;
        if (combo.length > 30) continue;
        const bestImg = keywordDemoBestImage.get(key)?.image || null;
        addOrUpdate(combo, 'contextual', { ptype: null }, ngramProductStock.get(kw) || 0, bestImg);
        ctxCount++;
    }

    // 2D. Contextual combos: product_type × demographic (e.g. "diapers for newborn")
    for (const [key, freq] of ptypeDemoFreq) {
        if (freq < MIN_COMBO_FREQ) continue;
        const [pt, demo] = key.split('|');
        if (!pt || !demo) continue;

        const combo = `${pt} ${demo}`;
        if (combo.length > 30) continue;
        const bestImg = ptypeDemoBestImage.get(key)?.image || null;
        addOrUpdate(combo, 'contextual', { ptype: pt }, 0, bestImg);
        ctxCount++;
    }
    console.log(`  → ${ctxCount} contextual suggestions (keyword×demo + ptype×demo)`);

    // ───────────────────────────────────────────────────────────────────────────
    // FILTERING & RANKING
    // ───────────────────────────────────────────────────────────────────────────

    const basePriorities = {
        brand_only: 10,
        ptype_only: 9,
        contextual: 8.5,
        brand_attribute: 8,
        brand_ptype: 7,
        keyword: 6,
        keyword_combo: 5.5
    };

    const finalRecords = [];
    const brandSet = new Set();

    for (const [, record] of suggestions) {
        // Frequency threshold filters
        if (record.type === 'brand_ptype' && record.product_count < MIN_BRAND_PTYPE_PRODUCTS) continue;
        if (['brand_only', 'ptype_only', 'brand_attribute'].includes(record.type) && record.product_count < 2) continue;
        // Keywords, combos and contextual already filtered by frequency above

        const priority = basePriorities[record.type] || 5;
        record.priority_score = Math.round((priority * 100) + (record.product_count * 5) - (record.suggestion.length * 3));

        delete record.max_stock_found;
        finalRecords.push(record);
        if (record.brand_name) brandSet.add(record.brand_name);
        if (typeCounts[record.type] !== undefined) typeCounts[record.type]++;
        else typeCounts[record.type] = 1;
    }

    console.log(`\nFiltered to ${finalRecords.length} total records.`);
    console.log('By type:', typeCounts);
    console.log('Rejections:', skipped);

    // ───────────────────────────────────────────────────────────────────────────
    // INDEX LOADING
    // ───────────────────────────────────────────────────────────────────────────

    console.log('\nClearing old index...');
    await suggestionIndex.clearObjects().wait();

    const chunkSize = 200;
    for (let i = 0; i < finalRecords.length; i += chunkSize) {
        const chunk = finalRecords.slice(i, i + chunkSize);
        await retry(() => suggestionIndex.saveObjects(chunk).wait());
        console.log(`  Batch ${Math.floor(i / chunkSize) + 1}/${Math.ceil(finalRecords.length / chunkSize)} → ${chunk.length} records`);
    }

    // ───────────────────────────────────────────────────────────────────────────
    // INDEX SETTINGS
    // ───────────────────────────────────────────────────────────────────────────

    console.log('\nApplying index settings...');
    await suggestionIndex.setSettings({
        searchableAttributes: [
            'unordered(suggestion)',
            'unordered(brand_name)',
            'unordered(product_type)',
            'unordered(searchable_text)'
        ],
        attributesForFaceting: ['brand_name', 'product_type', 'category_name', 'type'],
        customRanking: ['desc(priority_score)', 'desc(popularity_score)', 'desc(product_count)'],
        typoTolerance: 'min',
        ignorePlurals: true,
        removeStopWords: false,
        highlightPreTag: '<b>',
        highlightPostTag: '</b>'
    }).wait();

    // ───────────────────────────────────────────────────────────────────────────
    // BRAND DICTIONARY
    // ───────────────────────────────────────────────────────────────────────────

    const brandDictionary = Array.from(brandSet).map(brand => {
        const normalized = brand.toLowerCase().trim();
        return {
            original: brand,
            normalized,
            compact: normalized.replace(/[^a-z0-9]/g, ''),
            prefixes: [normalized.slice(0, 3), normalized.slice(0, 5), normalized.slice(0, 7)],
            phonetic: soundex(normalized)
        };
    });

    fs.writeFileSync('./brand_dictionary.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        total_brands: brandDictionary.length,
        brands: brandDictionary
    }, null, 2));

    console.log(`\n--- Phase 3 Generation Complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s ---`);
}

async function retry(fn, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); }
        catch (err) {
            lastError = err;
            if (err.status === 429) await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
            else throw err;
        }
    }
    throw lastError;
}

generateRefinedSuggestions().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
