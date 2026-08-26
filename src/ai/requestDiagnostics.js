const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;
const BASE64_MIN_REPORT_CHARS = 1_000_000;
const REPEAT_CHUNK_CHARS = 2048;

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
