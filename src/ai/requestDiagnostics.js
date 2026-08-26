const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;
const BASE64_MIN_REPORT_CHARS = 1_000_000;
const REPEAT_CHUNK_CHARS = 2048;
const FINGERPRINT_CHUNK_CHARS = 64 * 1024;
const STRUCTURE_KEYS = [
    'messages', 'role', 'content', 'system', 'prompt', 'character', 'persona',
    'memory', 'worldbook', 'lorebook', 'history', 'context', 'state', 'data',
    'embedding', 'vector', 'token',
];

function contentText(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    try { return JSON.stringify(content); } catch { return '[unserializable]'; }
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isBase64Char(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57) || code === 43 || code === 47
        || code === 45 || code === 95 || code === 61;
}

function inspectRuns(text) {
    let asciiChars = 0;
    let longestNoWhitespace = 0;
    let noWhitespaceStart = 0;
    let longestBase64 = 0;
    let base64Start = 0;
    let currentNoWhitespace = 0;
    let currentBase64 = 0;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code <= 0x7f) asciiChars++;
        if (!/\s/.test(text[i])) {
            currentNoWhitespace++;
            if (currentNoWhitespace > longestNoWhitespace) {
                longestNoWhitespace = currentNoWhitespace;
                noWhitespaceStart = i - currentNoWhitespace + 1;
            }
        } else currentNoWhitespace = 0;

        if (isBase64Char(code)) {
            currentBase64++;
            if (currentBase64 > longestBase64) {
                longestBase64 = currentBase64;
                base64Start = i - currentBase64 + 1;
            }
        } else currentBase64 = 0;
    }
    return { asciiChars, longestNoWhitespace, noWhitespaceStart, longestBase64, base64Start };
}

function decodedSizeEstimate(block) {
    const padding = block.endsWith('==') ? 2 : block.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(block.length * 3 / 4) - padding);
}

function imageSignature(block) {
    if (block.startsWith('iVBORw0KGgo')) return 'png';
    if (block.startsWith('/9j/')) return 'jpeg';
    if (block.startsWith('UklGR') && block.slice(8, 24).includes('V0VCUA')) return 'webp';
    return null;
}

function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function repeatStats(text) {
    const counts = new Map();
    let total = 0;
    for (let i = 0; i + REPEAT_CHUNK_CHARS <= text.length; i += REPEAT_CHUNK_CHARS) {
        const hash = fnv1a(text.slice(i, i + REPEAT_CHUNK_CHARS));
        counts.set(hash, (counts.get(hash) || 0) + 1);
        total++;
    }
    let repeated = 0;
    let maxSameChunkCount = 0;
    for (const count of counts.values()) {
        if (count > 1) repeated += count - 1;
        if (count > maxSameChunkCount) maxSameChunkCount = count;
    }
    return {
        chunkChars: REPEAT_CHUNK_CHARS,
        totalChunks: total,
        repeatedChunks: repeated,
        repeatedChunkRate: total ? Number((repeated / total).toFixed(6)) : 0,
        maxSameChunkCount,
    };
}

function shiftedRepeatStats(text) {
    const size = 256;
    const stride = 128;
    const counts = new Map();
    let total = 0;
    for (let i = 0; i + size <= text.length; i += stride) {
        const hash = fnv1a(text.slice(i, i + size));
        counts.set(hash, (counts.get(hash) || 0) + 1);
        total++;
    }
    let repeated = 0;
    let maxSameWindowCount = 0;
    for (const count of counts.values()) {
        if (count > 1) repeated += count - 1;
        if (count > maxSameWindowCount) maxSameWindowCount = count;
    }
    return {
        windowChars: size,
        strideChars: stride,
        totalWindows: total,
        repeatedWindows: repeated,
        repeatedWindowRate: total ? Number((repeated / total).toFixed(6)) : 0,
        maxSameWindowCount,
    };
}

function safePathKey(key) {
    return /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/.test(key)
        ? key
        : `<key#${fnv1a(key).toString(16).padStart(8, '0')}>`;
}

async function jsonStructureStats(text) {
    let root;
    try { root = JSON.parse(text); } catch { return { parseable: false }; }
    const stack = [{ value: root, path: '$', depth: 0 }];
    const strings = [];
    const arrays = [];
    const topLevelKeys = root && typeof root === 'object' && !Array.isArray(root)
        ? Object.keys(root).slice(0, 100).map(safePathKey)
        : [];
    let visitedNodes = 0;
    let maxDepth = 0;
    while (stack.length && visitedNodes < 100_000) {
        const { value, path, depth } = stack.pop();
        visitedNodes++;
        if (depth > maxDepth) maxDepth = depth;
        if (typeof value === 'string') {
            strings.push({ path, value });
            continue;
        }
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
            arrays.push({ path, length: value.length });
            for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
        } else {
            const entries = Object.entries(value);
            for (let i = entries.length - 1; i >= 0; i--) {
                const [key, child] = entries[i];
                stack.push({ value: child, path: `${path}.${safePathKey(key)}`, depth: depth + 1 });
            }
        }
    }
    strings.sort((a, b) => b.value.length - a.value.length);
    arrays.sort((a, b) => b.length - a.length);
    const largestStrings = [];
    for (const item of strings.slice(0, 12)) {
        const ascii = inspectRuns(item.value).asciiChars;
        largestStrings.push({
            path: item.path.slice(0, 512),
            chars: item.value.length,
            bytes: utf8Bytes(item.value),
            asciiRate: item.value.length ? Number((ascii / item.value.length).toFixed(6)) : 0,
            sha256: await sha256(item.value),
        });
    }
    return {
        parseable: true,
        rootType: Array.isArray(root) ? 'array' : typeof root,
        topLevelKeys,
        visitedNodes,
        maxDepth,
        traversalTruncated: stack.length > 0,
        stringLeafCount: strings.length,
        largestStrings,
        largestArrays: arrays.slice(0, 12),
    };
}

async function sampledGzipStats(text) {
    if (typeof CompressionStream !== 'function') return { supported: false };
    const part = Math.min(350_000, Math.floor(text.length / 3));
    const sample = text.length <= part * 3
        ? text
        : text.slice(0, part) + text.slice(Math.floor((text.length - part) / 2), Math.floor((text.length + part) / 2)) + text.slice(-part);
    const compressed = await new Response(
        new Blob([sample]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    const inputBytes = utf8Bytes(sample);
    return {
        supported: true,
        sampledChars: sample.length,
        sampledBytes: inputBytes,
        gzipBytes: compressed.byteLength,
        gzipRatio: inputBytes ? Number((compressed.byteLength / inputBytes).toFixed(6)) : 0,
    };
}

function ratio(value, total) {
    return total ? Number((value / total).toFixed(6)) : 0;
}

function countMatches(text, expression) {
    let count = 0;
    expression.lastIndex = 0;
    while (expression.exec(text)) count++;
    return count;
}

function charClass(value) {
    if (!value) return 'boundary';
    if (/\s/.test(value)) return 'whitespace';
    if (/[A-Za-z]/.test(value)) return 'letter';
    if (/[0-9]/.test(value)) return 'digit';
    if ('{}[]()'.includes(value)) return 'bracket';
    if ('\"\':,.-\\\\'.includes(value)) return 'punctuation';
    if (value.charCodeAt(0) <= 0x7f) return 'other_ascii';
    return 'non_ascii';
}

function parseFailureStats(text) {
    try {
        JSON.parse(text);
        return { parseable: true, offset: null };
    } catch (error) {
        const message = String(error?.message || '');
        const match = message.match(/(?:position|at position)\s+(\d+)/i)
            || message.match(/at\s+(\d+)\s*$/i);
        const offset = match ? Number(match[1]) : null;
        return {
            parseable: false,
            offset,
            locationTypes: offset == null ? null : {
                before16: Array.from(text.slice(Math.max(0, offset - 16), offset)).map(charClass),
                at: charClass(text[offset]),
                after16: Array.from(text.slice(offset + 1, offset + 17)).map(charClass),
            },
        };
    }
}

async function gzipRatioFor(text) {
    if (typeof CompressionStream !== 'function') return null;
    const inputBytes = utf8Bytes(text);
    const compressed = await new Response(
        new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    return ratio(compressed.byteLength, inputBytes);
}

function bracketAndNumericStats(text) {
    const stack = [];
    const totals = { curlyOpen: 0, curlyClose: 0, squareOpen: 0, squareClose: 0 };
    const completedTopLevel = [];
    const numericArrays = [];
    let mismatches = 0;
    let firstMismatchOffset = null;
    let maxEstimatedDepth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') {
            if (ch === '{') totals.curlyOpen++; else totals.squareOpen++;
            stack.push({
                type: ch,
                start: i,
                topLevel: stack.length === 0,
                numberCount: 0,
                commaCount: 0,
                disqualifying: 0,
            });
            if (stack.length > maxEstimatedDepth) maxEstimatedDepth = stack.length;
            continue;
        }
        if (ch === '}' || ch === ']') {
            if (ch === '}') totals.curlyClose++; else totals.squareClose++;
            const expected = ch === '}' ? '{' : '[';
            const frame = stack[stack.length - 1];
            if (!frame || frame.type !== expected) {
                mismatches++;
                if (firstMismatchOffset == null) firstMismatchOffset = i;
                continue;
            }
            stack.pop();
            if (frame.type === '[' && frame.numberCount >= 16
                && frame.disqualifying <= Math.max(2, Math.floor(frame.numberCount * 0.02))) {
                numericArrays.push({
                    start: frame.start,
                    end: i + 1,
                    length: i + 1 - frame.start,
                    numberCount: frame.numberCount,
                    commaCount: frame.commaCount,
                });
            }
            if (frame.topLevel && completedTopLevel.length < 20) {
                completedTopLevel.push({ start: frame.start, end: i + 1, type: frame.type === '{' ? 'object' : 'array' });
            }
            continue;
        }
        let arrayFrame = null;
        for (let j = stack.length - 1; j >= 0; j--) {
            if (stack[j].type === '[') { arrayFrame = stack[j]; break; }
        }
        if (!arrayFrame) continue;
        if (ch === ',') { arrayFrame.commaCount++; continue; }
        if (/\s/.test(ch)) continue;
        if (/[+\-.0-9eE]/.test(ch)) {
            const match = text.slice(i).match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
            if (match) {
                arrayFrame.numberCount++;
                i += match[0].length - 1;
                continue;
            }
        }
        if (ch !== '[' && ch !== ']') arrayFrame.disqualifying++;
    }
    numericArrays.sort((a, b) => b.numberCount - a.numberCount || b.length - a.length);
    return {
        ...totals,
        maxEstimatedDepth,
        mismatches,
        firstMismatchOffset,
        unclosedCount: stack.length,
        balanced: mismatches === 0 && stack.length === 0
            && totals.curlyOpen === totals.curlyClose && totals.squareOpen === totals.squareClose,
        completedTopLevel,
        numericArrays: numericArrays.slice(0, 12),
    };
}

async function structureFingerprint(text) {
    const length = text.length;
    const counts = {
        letters: 0, digits: 0, whitespace: 0, spaces: 0, newlines: 0,
        curlyOpen: 0, curlyClose: 0, squareOpen: 0, squareClose: 0,
        parenOpen: 0, parenClose: 0, quote: 0, colon: 0, comma: 0,
        dot: 0, hyphen: 0, backslash: 0, ascii: 0, punctuation: 0,
    };
    const structural = '{}[]():,".-\\';
    for (let i = 0; i < length; i++) {
        const ch = text[i];
        const code = text.charCodeAt(i);
        if (code <= 0x7f) counts.ascii++;
        if (/[A-Za-z]/.test(ch)) counts.letters++;
        else if (/[0-9]/.test(ch)) counts.digits++;
        if (/\s/.test(ch)) counts.whitespace++;
        if (ch === ' ') counts.spaces++;
        if (ch === '\n' || ch === '\r') counts.newlines++;
        if (ch === '{') counts.curlyOpen++; else if (ch === '}') counts.curlyClose++;
        else if (ch === '[') counts.squareOpen++; else if (ch === ']') counts.squareClose++;
        else if (ch === '(') counts.parenOpen++; else if (ch === ')') counts.parenClose++;
        else if (ch === '"') counts.quote++; else if (ch === ':') counts.colon++;
        else if (ch === ',') counts.comma++; else if (ch === '.') counts.dot++;
        else if (ch === '-') counts.hyphen++; else if (ch === '\\') counts.backslash++;
        if (structural.includes(ch)) counts.punctuation++;
    }
    const ratios = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, ratio(value, length)]));
    const escapes = {
        unicode: countMatches(text, /\\u[0-9a-fA-F]{4}/g),
        hex: countMatches(text, /\\x[0-9a-fA-F]{2}/g),
        escapedNewline: countMatches(text, /\\n/g),
        escapedReturn: countMatches(text, /\\r/g),
        escapedTab: countMatches(text, /\\t/g),
        percentHex: countMatches(text, /%[0-9a-fA-F]{2}/g),
        htmlNumericEntity: countMatches(text, /&#(?:\d+|x[0-9a-fA-F]+);/g),
        htmlNamedEntity: countMatches(text, /&[A-Za-z][A-Za-z0-9]{1,31};/g),
    };
    const keyCounts = {};
    for (const key of STRUCTURE_KEYS) {
        keyCounts[key] = countMatches(text, new RegExp(`['"]${key}['"]\\s*:`, 'gi'));
    }
    const brackets = bracketAndNumericStats(text);
    const boundaries = [];
    for (const item of brackets.completedTopLevel.slice(0, 12)) {
        const content = text.slice(item.start, item.end);
        boundaries.push({ ...item, length: item.end - item.start, sha256: await sha256(content) });
    }
    const firstBoundary = brackets.completedTopLevel[0] || null;
    const trailingNonWhitespace = firstBoundary
        ? text.slice(firstBoundary.end).search(/\S/)
        : -1;

    const chunks = [];
    for (let start = 0; start < length; start += FINGERPRINT_CHUNK_CHARS) {
        const chunk = text.slice(start, Math.min(length, start + FINGERPRINT_CHUNK_CHARS));
        let ascii = 0; let digits = 0; let punctuation = 0; let jsonMarks = 0;
        for (let i = 0; i < chunk.length; i++) {
            const ch = chunk[i];
            if (chunk.charCodeAt(i) <= 0x7f) ascii++;
            if (/[0-9]/.test(ch)) digits++;
            if (structural.includes(ch)) punctuation++;
            if ('{}[]":,'.includes(ch)) jsonMarks++;
        }
        chunks.push({
            index: chunks.length,
            start,
            length: chunk.length,
            asciiRatio: ratio(ascii, chunk.length),
            digitRatio: ratio(digits, chunk.length),
            punctuationRatio: ratio(punctuation, chunk.length),
            jsonStyleRatio: ratio(jsonMarks, chunk.length),
            gzipRatio: await gzipRatioFor(chunk),
        });
    }
    const metrics = ['asciiRatio', 'digitRatio', 'punctuationRatio', 'jsonStyleRatio', 'gzipRatio'];
    const chunkRanges = {};
    for (const metric of metrics) {
        const values = chunks.map((chunk) => chunk[metric]).filter((value) => value != null);
        chunkRanges[metric] = values.length ? {
            min: Math.min(...values), max: Math.max(...values), spread: Number((Math.max(...values) - Math.min(...values)).toFixed(6)),
        } : null;
    }
    const largestNumeric = brackets.numericArrays[0] || null;
    const numericArrayFingerprints = [];
    for (const item of brackets.numericArrays.slice(0, 5)) {
        numericArrayFingerprints.push({
            ...item,
            sha256: await sha256(text.slice(item.start, item.end)),
        });
    }
    return {
        chars: length,
        counts,
        ratios,
        escapes,
        keyCounts,
        parseFailure: parseFailureStats(text),
        brackets: {
            curlyOpen: brackets.curlyOpen, curlyClose: brackets.curlyClose,
            squareOpen: brackets.squareOpen, squareClose: brackets.squareClose,
            balanced: brackets.balanced, mismatches: brackets.mismatches,
            firstMismatchOffset: brackets.firstMismatchOffset,
            unclosedCount: brackets.unclosedCount,
            maxEstimatedDepth: brackets.maxEstimatedDepth,
        },
        concatenation: {
            completedTopLevelCount: brackets.completedTopLevel.length,
            multipleJsonLikeSegments: brackets.completedTopLevel.length > 1,
            jsonLikeThenTrailingText: Boolean(firstBoundary && trailingNonWhitespace >= 0),
            firstTrailingNonWhitespaceOffset: firstBoundary && trailingNonWhitespace >= 0
                ? firstBoundary.end + trailingNonWhitespace : null,
            boundaries,
        },
        numericData: {
            numericArrayCount: brackets.numericArrays.length,
            largestNumberCount: largestNumeric?.numberCount || 0,
            largestArrayChars: largestNumeric?.length || 0,
            likelyVectorLike: Boolean(largestNumeric && largestNumeric.numberCount >= 128),
            likelyTokenIds: Boolean(largestNumeric && largestNumeric.numberCount >= 128
                && counts.dot < Math.max(1, counts.digits * 0.01)),
            fingerprints: numericArrayFingerprints,
        },
        chunkChars: FINGERPRINT_CHUNK_CHARS,
        chunkRanges,
        chunks,
    };
}

async function analyzeSystemContent(text, messageIndex) {
    const lower = text.toLowerCase();
    const runs = inspectRuns(text);
    const blocks = [];
    const seen = new Set();
    const marker = /data:([^;,\s]{1,100})(?:;[^,\s]{0,200})?;base64,/gi;
    let match;
    while ((match = marker.exec(text)) && blocks.length < 5) {
        const start = marker.lastIndex;
        let end = start;
        while (end < text.length && isBase64Char(text.charCodeAt(end))) end++;
        if (end <= start) continue;
        const block = text.slice(start, end);
        seen.add(`${start}:${end}`);
        blocks.push({
            prefixType: match[1].toLowerCase().slice(0, 100),
            chars: block.length,
            decodedBytesEstimate: decodedSizeEstimate(block),
            imageSignature: imageSignature(block),
            sha256: await sha256(block),
        });
    }
    if (runs.longestBase64 >= BASE64_MIN_REPORT_CHARS
        && !Array.from(seen).some((range) => {
            const [start, end] = range.split(':').map(Number);
            return runs.base64Start >= start && runs.base64Start + runs.longestBase64 <= end;
        })) {
        const block = text.slice(runs.base64Start, runs.base64Start + runs.longestBase64);
        blocks.push({
            prefixType: 'unmarked',
            chars: block.length,
            decodedBytesEstimate: decodedSizeEstimate(block),
            imageSignature: imageSignature(block),
            sha256: await sha256(block),
        });
    }

    const fieldNames = ['avatar', 'background', 'image', 'attachment', 'dataUrl', 'base64'];
    const serializedFieldCounts = {};
    for (const field of fieldNames) {
        const expression = new RegExp(`["']${field}["']\\s*:`, 'gi');
        serializedFieldCounts[field] = (text.match(expression) || []).length;
    }

    return {
        messageIndex,
        chars: text.length,
        asciiChars: runs.asciiChars,
        asciiRate: text.length ? Number((runs.asciiChars / text.length).toFixed(6)) : 0,
        markers: {
            dataImage: lower.includes('data:image/'),
            base64: lower.includes(';base64,'),
            dataApplication: lower.includes('data:application/'),
        },
        longestNoWhitespaceChars: runs.longestNoWhitespace,
        longestBase64Chars: runs.longestBase64,
        millionScaleBase64: runs.longestBase64 >= BASE64_MIN_REPORT_CHARS,
        base64Blocks: blocks,
        serializedFieldCounts,
        looksJsonStringified: /^\s*[\[{]/.test(text) && /["'][^"']+["']\s*:/.test(text),
        repetition: repeatStats(text),
        shiftedRepetition: shiftedRepeatStats(text),
        jsonStructure: await jsonStructureStats(text),
        sampledGzip: await sampledGzipStats(text),
        structureFingerprint: await structureFingerprint(text),
    };
}

export async function buildGenerateDiagnostic({ requestId, rawBodyBytes, messages }) {
    const list = Array.isArray(messages) ? messages : [];
    const messageSizes = list.slice(0, 200).map((message, index) => {
        const content = contentText(message?.content);
        return {
            index,
            role: String(message?.role || 'unknown').slice(0, 32),
            chars: content.length,
            bytes: utf8Bytes(content),
        };
    });
    const systemMessages = list.filter((message) => String(message?.role || '').toLowerCase() === 'system');
    const systemTotals = systemMessages.reduce((totals, message) => {
        const content = contentText(message?.content);
        totals.chars += content.length;
        totals.bytes += utf8Bytes(content);
        return totals;
    }, { chars: 0, bytes: 0 });
    let largestSystem = null;
    for (let index = 0; index < list.length; index++) {
        if (String(list[index]?.role || '').toLowerCase() !== 'system') continue;
        const content = contentText(list[index]?.content);
        if (!largestSystem || content.length > largestSystem.content.length) largestSystem = { index, content };
    }

    return {
        event: 'generate_received',
        timestamp: new Date().toISOString(),
        requestId: String(requestId || '').slice(0, 128),
        bodyBytes: Number(rawBodyBytes) || 0,
        messagesLength: list.length,
        messageSizes,
        messageSizesTruncated: list.length > messageSizes.length,
        systemMessages: systemMessages.length,
        systemChars: systemTotals.chars,
        systemBytes: systemTotals.bytes,
        largestSystemAnalysis: largestSystem
            ? await analyzeSystemContent(largestSystem.content, largestSystem.index)
            : null,
    };
}

export function buildAiResultDiagnostic(requestId, error = null) {
    return {
        event: 'generate_ai_result',
        timestamp: new Date().toISOString(),
        requestId: String(requestId || '').slice(0, 128),
        ok: !error,
        status: error ? (Number(error.status) || null) : 200,
        errorType: error
            ? String(error.upstreamErrorType || error.code || error.name || 'Error').slice(0, 128)
            : null,
    };
}
