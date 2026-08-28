const BASELINE_BEGIN = 'BASE_PERSONA_BEGIN_7K4P';
const BASELINE_END = 'BASE_PERSONA_END_7K4P';
const ABNORMAL_BEGIN = '诊断标记_A01';
const BASELINE_KEY = 'diag:healthy-baseline:v1';
const BASELINE_TTL_SECONDS = 15 * 60;
const DEFAULT_BUDGET_MS = 8;
const MIN_CHUNK = 4096;
const MAX_CHUNK = 16384;
const CHUNK_MASK = 0x1fff; // average ~8 KiB
const MAX_STORED_CHUNKS = 512;

const encoder = new TextEncoder();

function safeRequestId(value) {
    return String(value || '').slice(0, 128);
}

function firstSystem(messages) {
    for (let index = 0; index < (Array.isArray(messages) ? messages.length : 0); index++) {
        const message = messages[index];
        if (String(message?.role || '').toLowerCase() !== 'system') continue;
        if (typeof message.content === 'string') return { index, content: message.content };
    }
    return null;
}

function hex(bytes) {
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hmac(value, secretBytes) {
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function deriveChunkKey(secretBytes) {
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('relay-diagnostic-chunks-v1')));
}

function canonical(value, seen = new WeakSet()) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value !== 'object') return JSON.stringify(`[${typeof value}]`);
    if (seen.has(value)) return '"[circular]"';
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    else {
        const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`);
        result = `{${entries.join(',')}}`;
    }
    seen.delete(value);
    return result;
}

// Only an in-memory digest is emitted. No settings, headers, credentials, or values are persisted.
async function peripheralFingerprint({ settings, maxTokens, messages }, secretBytes) {
    const shape = {
        settings,
        maxTokens: maxTokens ?? null,
        messageRoles: (Array.isArray(messages) ? messages : []).map((message) => String(message?.role || '').slice(0, 32)),
        messageCount: Array.isArray(messages) ? messages.length : 0,
    };
    return hmac(canonical(shape), secretBytes);
}

function seededHash(text, start, end, seedA, seedB) {
    let a = seedA >>> 0;
    let b = seedB >>> 0;
    for (let index = start; index < end; index++) {
        const code = text.charCodeAt(index);
        a = Math.imul(a ^ code, 16777619) >>> 0;
        b = (Math.imul(b, 33) ^ code) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

function chunkSummary(text, secretBytes, deadline) {
    const view = new DataView(secretBytes.buffer, secretBytes.byteOffset, secretBytes.byteLength);
    const seedA = view.getUint32(0, false) || 2166136261;
    const seedB = view.getUint32(4, false) || 5381;
    const chunks = [];
    let start = 0;
    let rolling = seedA;
    let interrupted = false;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        rolling = (Math.imul(rolling, 33) ^ code) >>> 0;
        const length = index + 1 - start;
        const boundary = length >= MIN_CHUNK && ((rolling & CHUNK_MASK) === 0 || length >= MAX_CHUNK);
        if (boundary) {
            if (chunks.length < MAX_STORED_CHUNKS) chunks.push({ offset: start, length, digest: seededHash(text, start, index + 1, seedA, seedB) });
            start = index + 1;
            rolling = seedA;
        }
        if ((index & 8191) === 0 && Date.now() >= deadline) { interrupted = true; break; }
    }
    if (!interrupted && start < text.length && chunks.length < MAX_STORED_CHUNKS) {
        chunks.push({ offset: start, length: text.length - start, digest: seededHash(text, start, text.length, seedA, seedB) });
    }
    return { chunks, interrupted, scannedChars: interrupted ? Math.min(text.length, chunks.at(-1)?.offset + chunks.at(-1)?.length || 0) : text.length };
}

function alignChunks(healthy, abnormal) {
    const positions = new Map();
    for (let index = 0; index < abnormal.length; index++) {
        const list = positions.get(abnormal[index].digest) || [];
        list.push(index);
        positions.set(abnormal[index].digest, list);
    }
    const matches = [];
    let after = -1;
    for (let healthyIndex = 0; healthyIndex < healthy.length; healthyIndex++) {
        const candidates = positions.get(healthy[healthyIndex].digest) || [];
        const abnormalIndex = candidates.find((index) => index > after && abnormal[index].length === healthy[healthyIndex].length);
        if (abnormalIndex == null) continue;
        matches.push({ healthyIndex, abnormalIndex });
        after = abnormalIndex;
    }
    const coveredChars = matches.reduce((sum, match) => sum + healthy[match.healthyIndex].length, 0);
    if (!matches.length) return { matches: 0, coveredChars, candidate: null };
    const candidates = [];
    const first = matches[0];
    const leadingExtra = abnormal[first.abnormalIndex].offset - healthy[first.healthyIndex].offset;
    if (leadingExtra > 0) candidates.push({ estimatedStart: 0, estimatedEnd: leadingExtra, length: leadingExtra });
    for (let index = 1; index < matches.length; index++) {
        const previous = matches[index - 1];
        const current = matches[index];
        const healthyPreviousEnd = healthy[previous.healthyIndex].offset + healthy[previous.healthyIndex].length;
        const abnormalPreviousEnd = abnormal[previous.abnormalIndex].offset + abnormal[previous.abnormalIndex].length;
        const healthyGap = healthy[current.healthyIndex].offset - healthyPreviousEnd;
        const abnormalGap = abnormal[current.abnormalIndex].offset - abnormalPreviousEnd;
        const extra = abnormalGap - healthyGap;
        if (extra > 0) candidates.push({ estimatedStart: abnormalPreviousEnd + healthyGap, estimatedEnd: abnormal[current.abnormalIndex].offset, length: extra });
    }
    const last = matches.at(-1);
    const healthyTail = healthy.at(-1).offset + healthy.at(-1).length
        - (healthy[last.healthyIndex].offset + healthy[last.healthyIndex].length);
    const abnormalTailStart = abnormal[last.abnormalIndex].offset + abnormal[last.abnormalIndex].length;
    const abnormalTail = abnormal.at(-1).offset + abnormal.at(-1).length - abnormalTailStart;
    if (abnormalTail > healthyTail) candidates.push({ estimatedStart: abnormalTailStart + healthyTail, estimatedEnd: abnormalTailStart + abnormalTail, length: abnormalTail - healthyTail });
    candidates.sort((a, b) => b.length - a.length);
    return {
        matches: matches.length,
        coveredChars,
        candidate: candidates[0] || null,
    };
}

function publicBase({ requestId, system, profile, preLength, peripheralHash, elapsedMs }) {
    return {
        event: 'generate_healthy_baseline_compare',
        timestamp: new Date().toISOString(),
        requestId: safeRequestId(requestId),
        profile,
        systemIndex: system.index,
        prePersonaChars: preLength,
        peripheralFingerprint: peripheralHash,
        elapsedMs,
    };
}

export async function buildPeripheralFingerprintDiagnostic({ requestId, messages, settings, maxTokens, diagnosticSecret }) {
    const system = firstSystem(messages);
    if (!system || !diagnosticSecret) return null;
    const hasHealthyMarker = system.content.includes(BASELINE_BEGIN) && system.content.includes(BASELINE_END);
    const hasAbnormalMarker = system.content.includes(ABNORMAL_BEGIN);
    if (!hasHealthyMarker && !hasAbnormalMarker) return null;
    const secret = encoder.encode(String(diagnosticSecret));
    return {
        event: 'generate_peripheral_fingerprint',
        timestamp: new Date().toISOString(),
        requestId: safeRequestId(requestId),
        profile: hasHealthyMarker ? 'healthy_baseline' : 'abnormal_marker',
        peripheralFingerprint: await peripheralFingerprint({ settings, maxTokens, messages }, secret),
    };
}

export async function runHealthyBaselineDiagnostic({ requestId, messages, settings, maxTokens, kv, diagnosticSecret, knownPeripheralFingerprint, budgetMs = DEFAULT_BUDGET_MS }) {
    const system = firstSystem(messages);
    if (!system || !kv || !diagnosticSecret) return null;
    const baselineOffset = system.content.indexOf(BASELINE_BEGIN);
    const baselineEnd = baselineOffset >= 0 ? system.content.indexOf(BASELINE_END, baselineOffset) : -1;
    const abnormalOffset = system.content.indexOf(ABNORMAL_BEGIN);
    if ((baselineOffset < 0 || baselineEnd < baselineOffset) && abnormalOffset < 0) return null;

    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1, Number(budgetMs) || DEFAULT_BUDGET_MS);
    const secret = encoder.encode(String(diagnosticSecret));
    const peripheralHash = knownPeripheralFingerprint
        || await peripheralFingerprint({ settings, maxTokens, messages }, secret);

    if (baselineOffset >= 0 && baselineEnd >= baselineOffset) {
        const pre = system.content.slice(0, baselineOffset);
        const chunkKey = await deriveChunkKey(secret);
        const summary = chunkSummary(pre, chunkKey, deadline);
        const record = {
            version: 1,
            createdAt: Date.now(),
            expiresAt: Date.now() + BASELINE_TTL_SECONDS * 1000,
            preLength: pre.length,
            preHmac: await hmac(pre, secret),
            peripheralHash,
            chunks: summary.chunks,
            chunkingInterrupted: summary.interrupted,
            scannedChars: summary.scannedChars,
        };
        record.summaryHmac = await hmac(canonical({ ...record, summaryHmac: undefined }), secret);
        await kv.put(BASELINE_KEY, JSON.stringify(record), { expirationTtl: BASELINE_TTL_SECONDS });
        return {
            ...publicBase({ requestId, system, profile: 'healthy_baseline', preLength: pre.length, peripheralHash, elapsedMs: Date.now() - startedAt }),
            baselineStored: true,
            ttlSeconds: BASELINE_TTL_SECONDS,
            chunkCount: summary.chunks.length,
            scannedChars: summary.scannedChars,
            interrupted: summary.interrupted,
            containsContent: false,
            safeHotfixEligible: false,
        };
    }

    const pre = system.content.slice(0, abnormalOffset);
    const rawRecord = await kv.get(BASELINE_KEY);
    if (!rawRecord) return {
        ...publicBase({ requestId, system, profile: 'abnormal_marker', preLength: pre.length, peripheralHash, elapsedMs: Date.now() - startedAt }),
        baselineAvailable: false,
        safeHotfixEligible: false,
    };
    let record;
    try { record = JSON.parse(rawRecord); } catch { record = null; }
    if (!Array.isArray(record?.chunks) || !Number.isInteger(record.preLength)) return null;
    const expectedHmac = await hmac(canonical({ ...record, summaryHmac: undefined }), secret);
    if (expectedHmac !== record.summaryHmac) return null;
    const chunkKey = await deriveChunkKey(secret);
    // Strongest and cheapest proofs first. A hit skips content-defined chunk scanning entirely.
    const suffixHash = pre.length >= record.preLength ? await hmac(pre.slice(pre.length - record.preLength), secret) : null;
    const prefixHash = suffixHash !== record.preHmac && pre.length >= record.preLength
        ? await hmac(pre.slice(0, record.preLength), secret)
        : null;
    let relation = 'undetermined';
    let exactBoundary = false;
    let candidateStart = null;
    let candidateEnd = null;
    let coverage = 0;
    let comparisonInterrupted = false;
    let abnormalChunkCount = 0;
    if (suffixHash === record.preHmac) {
        relation = 'extra + healthy';
        exactBoundary = true;
        candidateStart = 0;
        candidateEnd = pre.length - record.preLength;
        coverage = 1;
    } else if (prefixHash === record.preHmac) {
        relation = 'healthy + extra';
        exactBoundary = true;
        candidateStart = record.preLength;
        candidateEnd = pre.length;
        coverage = 1;
    } else if (Date.now() < deadline) {
        const abnormalSummary = chunkSummary(pre, chunkKey, deadline);
        abnormalChunkCount = abnormalSummary.chunks.length;
        comparisonInterrupted = abnormalSummary.interrupted;
        const aligned = alignChunks(record.chunks, abnormalSummary.chunks);
        coverage = record.preLength ? aligned.coveredChars / record.preLength : 0;
        if (aligned.candidate && coverage >= 0.5) {
            relation = 'A + extra + B candidate';
            candidateStart = aligned.candidate.estimatedStart;
            candidateEnd = aligned.candidate.estimatedEnd;
        } else relation = 'insufficient overlap';
    } else comparisonInterrupted = true;
    const peripheralMatch = peripheralHash === record.peripheralHash;
    const candidateLength = candidateStart != null && candidateEnd != null ? Math.max(0, candidateEnd - candidateStart) : null;
    // Eligibility is informational only. There is deliberately no request mutation or deletion path.
    const safeHotfixEligible = peripheralMatch && exactBoundary && candidateLength > 0;
    return {
        ...publicBase({ requestId, system, profile: 'abnormal_marker', preLength: pre.length, peripheralHash, elapsedMs: Date.now() - startedAt }),
        baselineAvailable: true,
        baselinePrePersonaChars: record.preLength,
        peripheralFingerprintMatch: peripheralMatch,
        relation,
        healthyChunkCoverage: Number(coverage.toFixed(6)),
        candidateStart,
        candidateEnd,
        candidateLength,
        exactBoundary,
        baselineChunkCount: record.chunks.length,
        abnormalChunkCount,
        comparisonInterrupted,
        safeHotfixEligible,
        contentPersisted: false,
    };
}

export const HEALTHY_BASELINE_MARKERS = { begin: BASELINE_BEGIN, end: BASELINE_END };
