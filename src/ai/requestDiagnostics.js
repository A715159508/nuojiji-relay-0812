const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;
const SAMPLE_CHARS = 4 * 1024;
const MAX_SAMPLES = 9;
const MAX_SCANNED_CHARS = SAMPLE_CHARS * MAX_SAMPLES;
const DIAGNOSTIC_BUDGET_MS = 5;
const MAX_GZIP_SOURCE_CHARS = 256 * 1024;
const STRUCTURE_KEYS = [
    'messages', 'role', 'content', 'system', 'prompt', 'character', 'persona',
    'memory', 'worldbook', 'lorebook', 'history', 'context', 'state', 'data',
    'embedding', 'vector', 'token',
];
const DIAGNOSTIC_MARKER_PREFIX = '诊断标记_A';
const DIAGNOSTIC_MARKERS = Array.from({ length: 11 }, (_, index) => `${DIAGNOSTIC_MARKER_PREFIX}${String(index + 1).padStart(2, '0')}`);
const PREPERSONA_BUDGET_MS = 12;
const PREPERSONA_SAMPLE_CHARS = 4 * 1024;
const PREPERSONA_MAX_SAMPLES = 48;
const PREPERSONA_MINHASH_SIZE = 32;
const BOUNDARY_HASH_SIZES = [256, 1024, 4096, 16384, 65536, 262144];
const PREPERSONA_KEYWORDS = new Set([
    'function', 'const', 'let', 'return', 'class', 'import', 'export', 'async', 'await',
    'schema', 'properties', 'required', 'description', 'system', 'prompt', 'preset',
    'rule', 'instruction', 'character', 'persona', 'memory', 'worldbook', 'lorebook',
    'context', 'template', 'macro', 'tool', 'messages', 'role', 'content',
]);
// Privacy-safe fingerprints of the unchanged normal persona. No persona text is embedded.
const NORMAL_PERSONA = {
    length: 16444,
    anchorChars: 96,
    first: [3413221475, 1584486629],
    last: [1892848219, 753359933],
    full: [3258446405, 1249998107],
};

function contentText(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    try { return JSON.stringify(content); } catch { return '[unserializable]'; }
}

function safeRequestId(requestId) {
    return String(requestId || '').slice(0, 128);
}

function ratio(value, total) {
    return total ? Number((value / total).toFixed(6)) : 0;
}

function firstSystem(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = 0; index < list.length; index++) {
        if (String(list[index]?.role || '').toLowerCase() === 'system') {
            return { index, content: contentText(list[index]?.content) };
        }
    }
    return null;
}

// Deliberately synchronous and cheap: this is logged before any deep diagnostics.
export function buildGenerateEntryDiagnostic({ requestId, rawBodyBytes, messages }) {
    const list = Array.isArray(messages) ? messages : [];
    const system = firstSystem(list);
    return {
        event: 'generate_received',
        timestamp: new Date().toISOString(),
        requestId: safeRequestId(requestId),
        bodyBytes: Number(rawBodyBytes) || 0,
        messagesLength: list.length,
        roles: list.slice(0, 32).map((message) => String(message?.role || 'unknown').slice(0, 32)),
        rolesTruncated: list.length > 32,
        firstSystemIndex: system?.index ?? null,
        firstSystemChars: system?.content.length ?? 0,
    };
}

// One forward-only scan. It logs marker positions only and never captures surrounding text.
export function buildMarkerOffsetDiagnostic({ requestId, messages }) {
    const system = firstSystem(messages);
    if (!system) return null;

    const text = system.content;
    const hits = new Map(DIAGNOSTIC_MARKERS.map((marker) => [marker, []]));
    let cursor = 0;
    while (cursor < text.length) {
        const offset = text.indexOf(DIAGNOSTIC_MARKER_PREFIX, cursor);
        if (offset < 0) break;
        const candidate = text.slice(offset, offset + DIAGNOSTIC_MARKER_PREFIX.length + 2);
        if (hits.has(candidate)) hits.get(candidate).push(offset);
        cursor = offset + DIAGNOSTIC_MARKER_PREFIX.length;
    }

    if (![...hits.values()].some((offsets) => offsets.length)) return null;
    let previousExpectedOffset = null;
    const markers = DIAGNOSTIC_MARKERS.map((marker) => {
        const offsets = hits.get(marker);
        const firstOffset = offsets[0] ?? null;
        const distanceFromPrevious = firstOffset != null && previousExpectedOffset != null
            ? firstOffset - previousExpectedOffset
            : null;
        if (firstOffset != null) previousExpectedOffset = firstOffset;
        return { marker, found: firstOffset != null, count: offsets.length, firstOffset, distanceFromPrevious };
    });
    const observed = markers.filter((marker) => marker.found).map((marker) => marker.firstOffset);
    return {
        event: 'generate_marker_offsets',
        timestamp: new Date().toISOString(),
        requestId: safeRequestId(requestId),
        systemIndex: system.index,
        systemChars: text.length,
        markers,
        missing: markers.filter((marker) => !marker.found).map((marker) => marker.marker),
        duplicated: markers.filter((marker) => marker.count > 1).map((marker) => marker.marker),
        outOfOrder: observed.some((offset, index) => index > 0 && offset <= observed[index - 1]),
    };
}

function polynomialHash(text, start, length, base) {
    let hash = 0;
    for (let index = start; index < start + length; index++) {
        hash = (Math.imul(hash, base) + text.charCodeAt(index) + 1) >>> 0;
    }
    return hash;
}

function fnvHash(text, start, length, seed) {
    let hash = seed >>> 0;
    for (let index = start; index < start + length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
}

function findNormalPersona(text, deadline) {
    const { length, anchorChars, first, last, full } = NORMAL_PERSONA;
    if (text.length < length) return { found: false, interrupted: false };
    const bases = [257, 263];
    const powers = bases.map((base) => {
        let value = 1;
        for (let index = 1; index < anchorChars; index++) value = Math.imul(value, base) >>> 0;
        return value;
    });
    const rolling = bases.map((base) => polynomialHash(text, 0, anchorChars, base));
    const lastStart = text.length - length;
    for (let start = 0; start <= lastStart; start++) {
        if ((start & 4095) === 0 && Date.now() >= deadline) return { found: false, interrupted: true };
        if (rolling[0] === first[0] && rolling[1] === first[1]) {
            const tailStart = start + length - anchorChars;
            const tailMatches = bases.every((base, index) => polynomialHash(text, tailStart, anchorChars, base) === last[index]);
            const fullMatches = tailMatches
                && fnvHash(text, start, length, 2166136261) === full[0]
                && fnvHash(text, start, length, 3339675911) === full[1];
            if (fullMatches) return { found: true, start, end: start + length, interrupted: false };
        }
        if (start === lastStart) break;
        for (let index = 0; index < bases.length; index++) {
            const outgoing = text.charCodeAt(start) + 1;
            const incoming = text.charCodeAt(start + anchorChars) + 1;
            const withoutFirst = (rolling[index] - Math.imul(outgoing, powers[index])) >>> 0;
            rolling[index] = (Math.imul(withoutFirst, bases[index]) + incoming) >>> 0;
        }
    }
    return { found: false, interrupted: false };
}

function prePersonaSampleStarts(length) {
    if (length <= PREPERSONA_SAMPLE_CHARS) return [0];
    const maxStart = Math.max(0, length - PREPERSONA_SAMPLE_CHARS);
    const starts = [];
    for (let index = 0; index < 8; index++) starts.push(Math.min(maxStart, index * PREPERSONA_SAMPLE_CHARS));
    for (let index = 0; index < 16; index++) starts.push(Math.max(0, maxStart - index * PREPERSONA_SAMPLE_CHARS));
    for (let index = 0; index < 24; index++) starts.push(Math.round(maxStart * index / 23));
    return [...new Set(starts)].sort((a, b) => a - b).slice(0, PREPERSONA_MAX_SAMPLES);
}

function scanPrePersonaSample(text, start, end, deadline, totals, keywordCounts, chunkHashes) {
    let hashA = 2166136261;
    let hashB = 3339675911;
    let wordStart = -1;
    for (let index = start; index < end; index++) {
        if ((index & 1023) === 0 && Date.now() >= deadline) return { interrupted: true, scannedEnd: index };
        const code = text.charCodeAt(index);
        hashA = Math.imul(hashA ^ code, 16777619) >>> 0;
        hashB = Math.imul(hashB ^ code, 16777619) >>> 0;
        totals.sampledChars++;
        if (code <= 127) totals.ascii++;
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
            totals.letters++;
            if (wordStart < 0) wordStart = index;
        } else {
            if (code >= 48 && code <= 57) totals.digits++;
            if (code === 32 || code === 9 || code === 10 || code === 13) totals.whitespace++;
            if (code === 10 || code === 13) totals.newlines++;
            if (code === 123) totals.curlyOpen++;
            else if (code === 125) totals.curlyClose++;
            else if (code === 91) totals.squareOpen++;
            else if (code === 93) totals.squareClose++;
            else if (code === 40) totals.parenOpen++;
            else if (code === 41) totals.parenClose++;
            else if (code === 34) totals.quotes++;
            else if (code === 58) totals.colons++;
            else if (code === 44) totals.commas++;
            else if (code === 92) totals.backslashes++;
            if (wordStart >= 0) {
                const word = text.slice(wordStart, index).toLowerCase();
                if (PREPERSONA_KEYWORDS.has(word)) keywordCounts[word]++;
                wordStart = -1;
            }
        }
    }
    if (wordStart >= 0) {
        const word = text.slice(wordStart, end).toLowerCase();
        if (PREPERSONA_KEYWORDS.has(word)) keywordCounts[word]++;
    }
    chunkHashes.push(`${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}`);
    return { interrupted: false, scannedEnd: end };
}

async function boundaryHashes(text, deadline) {
    if (Date.now() >= deadline) return { completed: false, prefix: {}, suffix: {} };
    const specs = [];
    for (const requested of BOUNDARY_HASH_SIZES) {
        if (requested > text.length) continue;
        specs.push({ requested, length: requested });
    }
    const prefix = {};
    const suffix = {};
    for (const spec of specs) {
        if (Date.now() >= deadline) return { completed: false, prefix, suffix };
        prefix[spec.requested] = await sha256(text.slice(0, spec.length));
        if (Date.now() >= deadline) return { completed: false, prefix, suffix };
        suffix[spec.requested] = await sha256(text.slice(text.length - spec.length));
    }
    return { completed: true, prefix, suffix };
}

export async function buildPrePersonaFingerprintDiagnostic({ requestId, messages, budgetMs = PREPERSONA_BUDGET_MS }) {
    const system = firstSystem(messages);
    if (!system) return null;
    const startedAt = Date.now();
    const effectiveBudget = Math.max(1, Number(budgetMs) || PREPERSONA_BUDGET_MS);
    const deadline = startedAt + effectiveBudget;
    const text = system.content;
    const markerStart = text.indexOf('诊断标记_A01');
    const markerEndStart = markerStart >= 0 ? text.indexOf('诊断标记_A11', markerStart) : -1;
    let profile = null;
    let personaStart = null;
    let personaEnd = null;
    let locatorInterrupted = false;
    if (markerStart >= 0 && markerEndStart >= markerStart) {
        profile = 'abnormal_marker';
        personaStart = markerStart;
        personaEnd = markerEndStart + '诊断标记_A11'.length;
    } else {
        const located = findNormalPersona(text, deadline);
        locatorInterrupted = located.interrupted;
        if (located.found) {
            profile = 'normal';
            personaStart = located.start;
            personaEnd = located.end;
        }
    }
    if (!profile) return {
        event: 'generate_prepersona_fingerprint', timestamp: new Date().toISOString(), requestId: safeRequestId(requestId),
        profile: 'unmatched', systemChars: text.length, personaFound: false,
        budgetMs: effectiveBudget, elapsedMs: Date.now() - startedAt, locatorInterrupted,
    };

    const preText = text.slice(0, personaStart);
    const totals = {
        sampledChars: 0, ascii: 0, letters: 0, digits: 0, whitespace: 0, newlines: 0,
        curlyOpen: 0, curlyClose: 0, squareOpen: 0, squareClose: 0,
        parenOpen: 0, parenClose: 0, quotes: 0, colons: 0, commas: 0, backslashes: 0,
    };
    const keywordCounts = Object.fromEntries([...PREPERSONA_KEYWORDS].map((keyword) => [keyword, 0]));
    const chunkHashes = [];
    const starts = prePersonaSampleStarts(preText.length);
    // Boundary hashes answer the main comparison question, so prioritize them before optional sampling.
    const boundaries = await boundaryHashes(preText, deadline);
    let interrupted = false;
    for (const start of starts) {
        if (Date.now() >= deadline) { interrupted = true; break; }
        const result = scanPrePersonaSample(preText, start, Math.min(preText.length, start + PREPERSONA_SAMPLE_CHARS), deadline, totals, keywordCounts, chunkHashes);
        if (result.interrupted) { interrupted = true; break; }
    }
    const minHash = [...new Set(chunkHashes)].sort().slice(0, PREPERSONA_MINHASH_SIZE);
    const sampled = Math.max(1, totals.sampledChars);
    let fullSha256 = null;
    let fullSha256Skipped = null;
    if (preText.length > 512 * 1024) fullSha256Skipped = 'large_input_cpu_safety';
    else if (Date.now() < deadline) fullSha256 = await sha256(preText);
    else fullSha256Skipped = 'budget';
    return {
        event: 'generate_prepersona_fingerprint', timestamp: new Date().toISOString(), requestId: safeRequestId(requestId),
        profile, systemIndex: system.index, systemChars: text.length, personaFound: true,
        personaStart, personaEnd, personaChars: personaEnd - personaStart,
        prePersonaChars: personaStart, postPersonaChars: text.length - personaEnd,
        budgetMs: effectiveBudget, elapsedMs: Date.now() - startedAt,
        completed: !interrupted && starts.length === chunkHashes.length && boundaries.completed,
        interrupted, sampledChars: totals.sampledChars, plannedSamples: starts.length, completedSamples: chunkHashes.length,
        ratios: {
            ascii: ratio(totals.ascii, sampled), letters: ratio(totals.letters, sampled),
            digits: ratio(totals.digits, sampled), whitespace: ratio(totals.whitespace, sampled),
        },
        punctuation: {
            curlyOpen: totals.curlyOpen, curlyClose: totals.curlyClose,
            squareOpen: totals.squareOpen, squareClose: totals.squareClose,
            parenOpen: totals.parenOpen, parenClose: totals.parenClose,
            quotes: totals.quotes, colons: totals.colons, commas: totals.commas,
            backslashes: totals.backslashes, newlines: totals.newlines,
        },
        keywordCounts, minHash, boundaryHashes: boundaries,
        fullSha256, fullSha256Skipped,
    };
}

function sampleStarts(length) {
    if (length <= SAMPLE_CHARS) return [0];
    const count = Math.min(MAX_SAMPLES, Math.ceil(length / SAMPLE_CHARS));
    const maxStart = Math.max(0, length - SAMPLE_CHARS);
    const evenlySpaced = [];
    for (let index = 0; index < count; index++) {
        evenlySpaced.push(Math.round(maxStart * index / Math.max(1, count - 1)));
    }
    // Budget exhaustion must still leave evidence from the beginning, middle, and end.
    const priority = [evenlySpaced[0], evenlySpaced[Math.floor(evenlySpaced.length / 2)], evenlySpaced.at(-1)];
    return [...new Set([...priority, ...evenlySpaced])];
}

function makeKeyMatcher() {
    const buckets = new Map();
    for (const key of STRUCTURE_KEYS) {
        const first = key.charCodeAt(0);
        if (!buckets.has(first)) buckets.set(first, []);
        buckets.get(first).push(key);
    }
    return buckets;
}

const KEY_BUCKETS = makeKeyMatcher();

function scanSample(text, start, deadline) {
    const end = Math.min(text.length, start + SAMPLE_CHARS);
    const counts = {
        ascii: 0, letters: 0, digits: 0, whitespace: 0, newlines: 0,
        punctuation: 0, jsonMarks: 0, quotes: 0, colons: 0, commas: 0,
        dots: 0, hyphens: 0, backslashes: 0,
        curlyOpen: 0, curlyClose: 0, squareOpen: 0, squareClose: 0,
        parenOpen: 0, parenClose: 0,
    };
    const escapes = {
        unicode: 0, hex: 0, escapedNewline: 0, escapedReturn: 0,
        escapedTab: 0, percentHex: 0, htmlNumericEntity: 0, htmlNamedEntity: 0,
    };
    const keyCounts = Object.fromEntries(STRUCTURE_KEYS.map((key) => [key, 0]));
    let estimatedDepth = 0;
    let maxEstimatedDepth = 0;
    let bracketMismatches = 0;
    let inString = false;
    let escaped = false;
    let numberTokens = 0;
    let consecutiveNumericItems = 0;
    let maxConsecutiveNumericItems = 0;
    let previousTokenWasNumber = false;
    let scannedEnd = start;
    let interrupted = false;

    for (let i = start; i < end; i++) {
        if ((i & 1023) === 0 && Date.now() >= deadline) { interrupted = true; break; }
        scannedEnd = i + 1;
        const ch = text[i];
        const code = text.charCodeAt(i);
        if (code <= 0x7f) counts.ascii++;
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) counts.letters++;
        else if (code >= 48 && code <= 57) counts.digits++;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') counts.whitespace++;
        if (ch === '\n' || ch === '\r') counts.newlines++;

        if (ch === '"') counts.quotes++;
        else if (ch === ':') counts.colons++;
        else if (ch === ',') counts.commas++;
        else if (ch === '.') counts.dots++;
        else if (ch === '-') counts.hyphens++;
        else if (ch === '\\') counts.backslashes++;
        if ('{}[]():,".-\\'.includes(ch)) counts.punctuation++;
        if ('{}[]":,'.includes(ch)) counts.jsonMarks++;

        if (ch === '\\') {
            const a = text[i + 1];
            const tail4 = text.slice(i + 2, i + 6);
            const tail2 = text.slice(i + 2, i + 4);
            if (a === 'u' && /^[0-9a-fA-F]{4}$/.test(tail4)) escapes.unicode++;
            else if (a === 'x' && /^[0-9a-fA-F]{2}$/.test(tail2)) escapes.hex++;
            else if (a === 'n') escapes.escapedNewline++;
            else if (a === 'r') escapes.escapedReturn++;
            else if (a === 't') escapes.escapedTab++;
        } else if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
            escapes.percentHex++;
        } else if (ch === '&') {
            const semi = text.indexOf(';', i + 1);
            if (semi > i && semi - i <= 34) {
                const entity = text.slice(i + 1, semi);
                if (/^#(?:\d+|x[0-9a-fA-F]+)$/.test(entity)) escapes.htmlNumericEntity++;
                else if (/^[A-Za-z][A-Za-z0-9]{1,31}$/.test(entity)) escapes.htmlNamedEntity++;
            }
        }

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            const firstCode = text.charCodeAt(i + 1);
            const candidates = KEY_BUCKETS.get(firstCode) || [];
            for (const key of candidates) {
                const keyEnd = i + 1 + key.length;
                if (text.slice(i + 1, keyEnd).toLowerCase() !== key) continue;
                if (text[keyEnd] !== '"') continue;
                let cursor = keyEnd + 1;
                while (cursor < end && /\s/.test(text[cursor])) cursor++;
                if (text[cursor] === ':') keyCounts[key]++;
            }
            continue;
        }

        if (ch === '{') { counts.curlyOpen++; estimatedDepth++; }
        else if (ch === '[') { counts.squareOpen++; estimatedDepth++; consecutiveNumericItems = 0; }
        else if (ch === '}' || ch === ']') {
            if (ch === '}') counts.curlyClose++; else counts.squareClose++;
            if (estimatedDepth > 0) estimatedDepth--; else bracketMismatches++;
        } else if (ch === '(') counts.parenOpen++;
        else if (ch === ')') counts.parenClose++;
        if (estimatedDepth > maxEstimatedDepth) maxEstimatedDepth = estimatedDepth;

        if ((code >= 48 && code <= 57) || ((ch === '-' || ch === '+') && /[0-9.]/.test(text[i + 1] || ''))) {
            let cursor = i + 1;
            while (cursor < end && /[0-9eE+\-.]/.test(text[cursor])) cursor++;
            numberTokens++;
            consecutiveNumericItems = previousTokenWasNumber ? consecutiveNumericItems + 1 : 1;
            if (consecutiveNumericItems > maxConsecutiveNumericItems) maxConsecutiveNumericItems = consecutiveNumericItems;
            previousTokenWasNumber = true;
            i = cursor - 1;
        } else if (ch !== ',' && !/\s/.test(ch)) {
            previousTokenWasNumber = false;
            consecutiveNumericItems = 0;
        }
    }

    const scannedChars = Math.max(0, scannedEnd - start);
    return {
        start,
        length: scannedChars,
        interrupted,
        ratios: {
            ascii: ratio(counts.ascii, scannedChars),
            letters: ratio(counts.letters, scannedChars),
            digits: ratio(counts.digits, scannedChars),
            whitespace: ratio(counts.whitespace, scannedChars),
            punctuation: ratio(counts.punctuation, scannedChars),
            jsonStyle: ratio(counts.jsonMarks, scannedChars),
        },
        counts,
        escapes,
        keyCounts,
        structure: { estimatedDepthDelta: estimatedDepth, maxEstimatedDepth, bracketMismatches },
        numeric: { numberTokens, maxConsecutiveNumericItems, likelyNumericArray: maxConsecutiveNumericItems >= 32 },
    };
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function gzipSample(value) {
    if (typeof CompressionStream !== 'function') return { supported: false };
    const bytes = utf8Bytes(value);
    const compressed = await new Response(new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    return { supported: true, sampledBytes: bytes, gzipBytes: compressed.byteLength, gzipRatio: ratio(compressed.byteLength, bytes) };
}

function rangeFor(samples, field) {
    const values = samples.map((sample) => sample.ratios[field]);
    return values.length ? { min: Math.min(...values), max: Math.max(...values), spread: Number((Math.max(...values) - Math.min(...values)).toFixed(6)) } : null;
}

function classify(samples, keyCounts) {
    const maxNumeric = Math.max(0, ...samples.map((sample) => sample.numeric.maxConsecutiveNumericItems));
    const avgDigits = samples.length ? samples.reduce((sum, sample) => sum + sample.ratios.digits, 0) / samples.length : 0;
    const avgJson = samples.length ? samples.reduce((sum, sample) => sum + sample.ratios.jsonStyle, 0) / samples.length : 0;
    const structuredKeys = Object.values(keyCounts).reduce((sum, value) => sum + value, 0);
    return {
        likelyVectorOrTokenArray: maxNumeric >= 32 || avgDigits >= 0.35,
        likelyJsonLikeSerialization: structuredKeys >= 2 || avgJson >= 0.08,
        likelyEscapedText: samples.some((sample) => sample.counts.backslashes / Math.max(1, sample.length) >= 0.03),
        maxConsecutiveNumericItems: maxNumeric,
    };
}

// Bounded sampled diagnostics: no more than 36 KiB is scanned, with cooperative deadline checks.
export async function buildGenerateDiagnostic({ requestId, rawBodyBytes, messages, budgetMs = DIAGNOSTIC_BUDGET_MS }) {
    const system = firstSystem(messages);
    const startedAt = Date.now();
    const effectiveBudget = Math.max(1, Number(budgetMs) || DIAGNOSTIC_BUDGET_MS);
    const deadline = startedAt + effectiveBudget;
    if (!system) return { event: 'generate_structure', timestamp: new Date().toISOString(), requestId: safeRequestId(requestId), skipped: 'no_system' };

    const text = system.content;
    const starts = sampleStarts(text.length);
    const samples = [];
    for (const start of starts) {
        if (Date.now() >= deadline) break;
        const sample = scanSample(text, start, deadline);
        samples.push(sample);
        if (sample.interrupted) break;
    }

    const keyCounts = Object.fromEntries(STRUCTURE_KEYS.map((key) => [key, 0]));
    for (const sample of samples) for (const key of STRUCTURE_KEYS) keyCounts[key] += sample.keyCounts[key];
    const ranges = {
        ascii: rangeFor(samples, 'ascii'), digits: rangeFor(samples, 'digits'),
        punctuation: rangeFor(samples, 'punctuation'), jsonStyle: rangeFor(samples, 'jsonStyle'),
    };
    let mostDistinctSample = null;
    if (samples.length > 1) {
        const fields = ['ascii', 'digits', 'punctuation', 'jsonStyle'];
        const averages = Object.fromEntries(fields.map((field) => [field, samples.reduce((sum, sample) => sum + sample.ratios[field], 0) / samples.length]));
        mostDistinctSample = samples.map((sample) => ({
            start: sample.start, length: sample.length,
            score: fields.reduce((sum, field) => sum + Math.abs(sample.ratios[field] - averages[field]), 0),
        })).sort((a, b) => b.score - a.score)[0];
        mostDistinctSample.score = Number(mostDistinctSample.score.toFixed(6));
    }

    let sampledCompression = { skipped: text.length > MAX_GZIP_SOURCE_CHARS ? 'large_input_cpu_safety' : 'budget' };
    let sampleSha256 = null;
    if (Date.now() < deadline && samples.length) {
        const selected = [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]];
        const combined = selected.map((sample) => text.slice(sample.start, sample.start + sample.length)).join('');
        sampleSha256 = await sha256(combined);
        if (text.length <= MAX_GZIP_SOURCE_CHARS && Date.now() < deadline) sampledCompression = await gzipSample(combined);
    }

    return {
        event: 'generate_structure', timestamp: new Date().toISOString(), requestId: safeRequestId(requestId),
        bodyBytes: Number(rawBodyBytes) || 0, systemIndex: system.index, systemChars: text.length,
        budgetMs: effectiveBudget, elapsedMs: Date.now() - startedAt,
        completed: samples.length === starts.length && !samples.some((sample) => sample.interrupted),
        sampledChars: samples.reduce((sum, sample) => sum + sample.length, 0),
        maxSampledChars: MAX_SCANNED_CHARS, sampleSha256, sampledCompression,
        keyCounts, ranges, mostDistinctSample, classification: classify(samples, keyCounts), samples,
    };
}

export function buildAiResultDiagnostic(requestId, error = null) {
    return {
        event: 'generate_ai_result', timestamp: new Date().toISOString(), requestId: safeRequestId(requestId),
        ok: !error, status: error ? (Number(error.status) || null) : 200,
        errorType: error ? String(error.upstreamErrorType || error.code || error.name || 'Error').slice(0, 128) : null,
    };
}
