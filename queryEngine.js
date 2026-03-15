/**
 * ACS Phase 3: Autocomplete Query Engine
 *
 * Phase 3 additions:
 * - Live Product Fallback: if ACS index has 0 results, search the product catalog
 *   directly and synthesize suggestions from it. Scalable catch-all for any term.
 * - Contextual scoring boost: exact keyword matches boost extension suggestions
 *   ("sleeveless for boys", "almond oil") so they appear right below the base.
 */

const algoliasearch = require('algoliasearch');
const fs = require('fs');
require('dotenv').config();

// ─── Config ─────────────────────────────────────────────────────────────────

const {
    ALGOLIA_APP_ID,
    ALGOLIA_API_KEY,
    ALGOLIA_INDEX_NAME,
    ALGOLIA_SUGGESTION_INDEX,
    SHOW_CONTEXTUAL
} = {
    ALGOLIA_APP_ID: (process.env.ALGOLIA_APP_ID || '').trim(),
    ALGOLIA_API_KEY: (process.env.ALGOLIA_API_KEY || '').trim(),
    ALGOLIA_INDEX_NAME: (process.env.ALGOLIA_INDEX_NAME || '').trim(),
    ALGOLIA_SUGGESTION_INDEX: (process.env.ALGOLIA_SUGGESTION_INDEX || '').trim(),
    SHOW_CONTEXTUAL: (process.env.SHOW_CONTEXTUAL || 'true').trim().toLowerCase() !== 'false'
};

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_API_KEY);
const suggestionIndex = client.initIndex(ALGOLIA_SUGGESTION_INDEX);
const productIndex = client.initIndex(ALGOLIA_INDEX_NAME);  // for live fallback

const path = require('path');

// ─── Synonym Map ─────────────────────────────────────────────────────────────
// Built from synonyms.json. Each alternate term maps to the first (canonical) term.
// E.g. "nappies" → "diaper", "pram" → "stroller"

const synonymMap = {};   // alternate → canonical
const canonicalTerms = new Set(); // canonical terms (first in each synonym group)
try {
    const rawSynonyms = JSON.parse(fs.readFileSync(path.join(__dirname, 'synonyms.json'), 'utf8'));
    rawSynonyms.forEach(group => {
        if (!group.synonyms || group.synonyms.length < 2) return;
        const canonical = group.synonyms[0].toLowerCase();
        canonicalTerms.add(canonical);
        // Map every alternate (index >= 1) to the canonical
        group.synonyms.slice(1).forEach(term => {
            synonymMap[term.toLowerCase()] = canonical;
        });
    });
} catch (err) {
    console.error('[ACS] Could not load synonyms.json:', err.message);
}

// Load brand names so we never synonym-substitute a brand
const brandNames = new Set();
try {
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'brand_dictionary.json'), 'utf8'));
    dict.brands.forEach(b => {
        brandNames.add(b.normalized);
        brandNames.add(b.compact);
    });
} catch (err) {
    console.warn('[ACS] Could not load brand_dictionary.json:', err.message);
}

// Build a compact→original brand lookup for multi-word fuzzy matching
// e.g. "mamypoko" → "MamyPokoPants", "miarcus" → "Mi Arcus"
const compactBrandLookup = {};  // compact → original brand name
try {
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'brand_dictionary.json'), 'utf8'));
    dict.brands.forEach(b => {
        if (b.compact) compactBrandLookup[b.compact] = b.original;
        if (b.normalized) compactBrandLookup[b.normalized] = b.original;
    });
} catch (err) {
    // already warned above
}

// ─── Query Normalization ──────────────────────────────────────────────────────

/**
 * normalizeQuery: clean, synonym-expand, and optionally fuzzy-resolve brand.
 * Returns { query: string, isTrailingSpace: bool, resolvedBrand: string|null }
 */
function normalizeQuery(raw) {
    // Detect if user pressed space after a word (signals "refine" intent)
    const isTrailingSpace = raw.endsWith(' ') && raw.trim().length >= 3;

    let q = raw.toLowerCase().trim();
    q = q.replace(/[\/\.\&\-]/g, ' ');
    q = q.replace(/\s+/g, ' ').trim();

    // Full-phrase synonym substitution (never word-by-word, never brands)
    if (synonymMap[q] && !brandNames.has(q) && !canonicalTerms.has(q)) {
        return { query: synonymMap[q], isTrailingSpace, resolvedBrand: null };
    }

    // Multi-word brand fuzzy resolution:
    // "mamy polo" → compact → "mamypolo" → fuzzy match brands → "MamyPokoPants"
    const resolved = resolveMultiWordBrand(q);
    if (resolved) {
        return { query: resolved.toLowerCase(), isTrailingSpace, resolvedBrand: resolved };
    }

    return { query: q, isTrailingSpace, resolvedBrand: null };
}

/**
 * If a multi-word query compacts to something close to a known brand compact name,
 * return that brand's original name so we can search with it directly.
 */
function resolveMultiWordBrand(q) {
    const words = q.split(' ');
    if (words.length < 2) return null;

    // Try exact compact match first (e.g. "mamy poko" → "mamypoko")
    const compacted = words.join('');
    if (compactBrandLookup[compacted]) {
        return compactBrandLookup[compacted];
    }

    // Try prefix compact match: "mamy pol" → "mamypol..." → find brand starting with it
    const match = Object.keys(compactBrandLookup).find(key => key.startsWith(compacted));
    if (match) return compactBrandLookup[match];

    // Fuzzy: allow 1 char difference using simple edit distance on compact form
    for (const [key, original] of Object.entries(compactBrandLookup)) {
        if (Math.abs(key.length - compacted.length) <= 2 && editDistance(key, compacted) <= 2) {
            return original;
        }
    }

    return null;
}

/** Levenshtein distance (capped at 3 for performance) */
function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

// ─── Algolia Search Params by Length ────────────────────────────────────────

/**
 * Returns Algolia search params tuned to the query length.
 * Short queries (3 chars) are broad; longer ones are precise.
 */
function buildSearchParams(normalizedQuery, mode = 'default') {
    const len = normalizedQuery.length;
    const base = {
        hitsPerPage: 20,
        attributesToRetrieve: ['suggestion', 'type', 'brand_name', 'product_type', 'popularity_score', 'product_count', 'representative_image', '_highlightResult'],
        attributesToHighlight: ['suggestion'],
        highlightPreTag: '<b>',
        highlightPostTag: '</b>',
        typoTolerance: 'min'
    };

    // TRAILING SPACE MODE: user finished a word — search for combinations starting with base term
    if (mode === 'refine') {
        return {
            ...base,
            restrictSearchableAttributes: ['suggestion'],
            queryType: 'prefixLast',
            typoTolerance: 'min',
            hitsPerPage: 15
        };
    }

    if (len === 3) {
        return {
            ...base,
            restrictSearchableAttributes: ['suggestion', 'brand_name', 'product_type', 'searchable_text'],
            queryType: 'prefixLast',
            typoTolerance: false
        };
    } else if (len <= 6) {
        return {
            ...base,
            restrictSearchableAttributes: ['suggestion', 'brand_name'],
            queryType: 'prefixLast',
            typoTolerance: 'min'
        };
    } else {
        return {
            ...base,
            restrictSearchableAttributes: ['suggestion'],
            queryType: 'prefixAll',
            typoTolerance: 'min'
        };
    }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Client-side score layered on top of Algolia's ranking.
 * Exact match always wins regardless of other signals.
 *
 * score = (exact_match ? 1000 : 0) +
 *         (prefix_match ? 500 : 0) +
 *         (contains_match ? 200 : 0) +
 *         (brand_match ? 300 : 0) +
 *         (popularity_score * 0.01) +
 *         (product_count * 2) -
 *         (text_length * 3)
 */
function scoreHit(hit, normalizedQuery) {
    const suggestion = (hit.suggestion || '').toLowerCase();
    const query = normalizedQuery.toLowerCase();
    const brand = (hit.brand_name || '').toLowerCase();

    const exactMatch = suggestion === query;
    const prefixMatch = suggestion.startsWith(query);
    const containsMatch = !prefixMatch && suggestion.includes(query);
    const brandMatch = brand && brand.startsWith(query);

    // Exact word boundary checks to fix prefix pollution (e.g., "bat" matching "bath")
    const queryWords = query.split(/\s+/);
    const suggestionWords = suggestion.split(/\s+/);
    const hasExactWordMatch = suggestionWords.some(w => queryWords.includes(w));
    const hasBuriedPrefix = !hasExactWordMatch && suggestionWords.some(w => w.startsWith(query) && w !== query);

    return (exactMatch ? 1000 : 0) +
        (prefixMatch ? 500 : 0) +
        (hasExactWordMatch && query.length <= 4 ? 600 : 0) +
        (hasBuriedPrefix && query.length <= 4 ? -200 : 0) +
        (containsMatch ? 200 : 0) +
        (brandMatch ? 300 : 0) +
        ((hit.popularity_score || 0) * 0.01) +
        ((hit.product_count || 0) * 2) -
        (suggestion.length * 3) +
        // Contextual extension suggestions (e.g. "sleeveless for boys") get
        // a boost when they extend the exact query — surfaces Amazon-style refinements
        (['contextual', 'keyword_combo'].includes(hit.type) && suggestion.startsWith(query) ? 400 : 0);
}

// ─── Format Result ────────────────────────────────────────────────────────────

function formatHit(hit, normalizedQuery, score) {
    // Use Algolia's highlighted text if available, else build manually
    const highlighted =
        hit._highlightResult?.suggestion?.value ||
        hit.suggestion.replace(
            new RegExp(`(${normalizedQuery})`, 'gi'),
            '<b>$1</b>'
        );

    return {
        text: hit.suggestion,
        highlighted,
        type: hit.type,
        brand: hit.brand_name || null,
        product_type: hit.product_type || null,
        image: hit.representative_image || null,
        score: Math.round(score)
    };
}

// ─── Live Product Fallback ───────────────────────────────────────────────────
//
// When the ACS suggestion index returns 0 hits for a query, we search the main
// product catalog directly and synthesize brand+ptype suggestions from real hits.
// This is the ultimate catch-all for any term that appears in product names.

async function liveProductFallback(rawQuery) {
    try {
        const result = await productIndex.search(rawQuery, {
            hitsPerPage: 8,
            attributesToRetrieve: ['brand_name', 'product_type', 'name', 'image', 'variants'],
            typoTolerance: true,
            queryType: 'prefixLast'
        });

        const seen = new Set();
        const syntheticHits = [];

        for (const h of result.hits) {
            const pt = (h.product_type || '').trim().toLowerCase();
            const br = (h.brand_name || '').trim();
            const rawImg = h.image || (h.variants?.[0]?.image);
            const img = rawImg ? (rawImg.startsWith('http') ? rawImg : `https://d14xdfvauagpvz.cloudfront.net/product/${rawImg}`) : null;

            // product_type only
            if (pt && !seen.has(pt)) {
                seen.add(pt);
                syntheticHits.push({
                    suggestion: h.product_type,
                    type: 'live_fallback',
                    brand_name: null,
                    product_type: h.product_type,
                    representative_image: img,
                    product_count: 1,
                    popularity_score: 0
                });
            }

            // brand + product_type combo
            if (br && pt) {
                const combo = `${br} ${h.product_type}`;
                const comboKey = combo.toLowerCase();
                if (combo.length <= 30 && !seen.has(comboKey)) {
                    seen.add(comboKey);
                    syntheticHits.push({
                        suggestion: combo,
                        type: 'live_fallback',
                        brand_name: br,
                        product_type: h.product_type,
                        representative_image: img,
                        product_count: 1,
                        popularity_score: 0
                    });
                }
            }

            if (syntheticHits.length >= 5) break;
        }

        if (syntheticHits.length > 0) {
            console.log(`[ACS] Live fallback: ${syntheticHits.length} synthetic hits for "${rawQuery}"`);
        }
        return syntheticHits;
    } catch (err) {
        console.warn('[ACS] Live fallback search failed:', err.message);
        return [];
    }
}

// ─── Core Search ─────────────────────────────────────────────────────────────

async function fetchSuggestions(normalizedQuery, isTrailingSpace) {
    const mode = isTrailingSpace ? 'refine' : 'default';
    const params = buildSearchParams(normalizedQuery, mode);
    let hits = [];

    try {
        const result = await suggestionIndex.search(normalizedQuery, params);
        hits = result.hits;
    } catch (err) {
        console.warn('[ACS] Primary search failed:', err.message);
    }

    // Retry with broader typo tolerance if too few results
    if (hits.length < 3) {
        try {
            const retry = await suggestionIndex.search(normalizedQuery, {
                ...params,
                typoTolerance: true,
                hitsPerPage: 20
            });
            hits = retry.hits;
        } catch (err) {
            console.warn('[ACS] Retry search failed:', err.message);
        }
    }

    // Layer 2: Live Product Fallback — search product catalog directly
    // Only triggered when ACS index truly has nothing for this query.
    if (hits.length === 0) {
        hits = await liveProductFallback(normalizedQuery);
    }

    return hits;
}

// ─── Main Query Function ──────────────────────────────────────────────────────

/**
 * Primary entry point. Normalizes the query, executes the evolving search,
 * scores results client-side, and returns a structured response.
 *
 * @param {string} rawQuery - The raw user input
 * @returns {Promise<Object>} - Suggestions response
 */
async function query(rawQuery) {
    const startTime = Date.now();

    // Gate: require at least 3 characters (not counting trailing space)
    if ((rawQuery || '').trim().length < 3) {
        return { suggestions: [], query: (rawQuery || '').trim(), count: 0, latency_ms: 0 };
    }

    const { query: normalizedQuery, isTrailingSpace, resolvedBrand } = normalizeQuery(rawQuery);

    // If a multi-word brand was resolved, use its name as the effective search query
    const searchQuery = resolvedBrand ? resolvedBrand.toLowerCase() : normalizedQuery;

    const hits = await fetchSuggestions(searchQuery, isTrailingSpace);

    // Score and sort using the original normalizedQuery for accuracy
    const scored = hits
        .map(hit => ({ hit, score: scoreHit(hit, searchQuery) }))
        .sort((a, b) => b.score - a.score);

    // Exact match guarantee
    const exactIndex = scored.findIndex(
        s => s.hit.suggestion.toLowerCase() === searchQuery
    );
    if (exactIndex > 0) {
        const [exact] = scored.splice(exactIndex, 1);
        scored.unshift(exact);
    }

    const finalScored = SHOW_CONTEXTUAL
        ? scored
        : scored.filter(({ hit }) => hit.type !== 'contextual');

    const suggestions = finalScored.slice(0, 8).map(({ hit, score }) =>
        formatHit(hit, searchQuery, score)
    );

    return {
        suggestions,
        query: rawQuery.trim(),
        count: suggestions.length,
        latency_ms: Date.now() - startTime
    };
}

// ─── Debounced Entry Point ────────────────────────────────────────────────────

let debounceTimer = null;

/**
 * Debounced version of query(). Waits 150ms after the last keystroke.
 * Pass onResult(response) callback to receive the result.
 * Call with rapid=true (e.g. on backspace detection) to skip the delay.
 *
 * @param {string} rawQuery
 * @param {function} onResult - Callback receiving the response object
 * @param {boolean} rapid - Skip debounce delay (e.g. for backspace)
 */
function debouncedQuery(rawQuery, onResult, rapid = false) {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }

    const delay = rapid ? 0 : 150;

    debounceTimer = setTimeout(async () => {
        const result = await query(rawQuery);
        onResult(result);
    }, delay);
}

// ─── Init & Export ────────────────────────────────────────────────────────────

module.exports = {
    query,
    debouncedQuery,
    normalizeQuery
};
