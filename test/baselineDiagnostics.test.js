import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKvStore } from '../src/store/kvStore.js';
import { buildPeripheralFingerprintDiagnostic, runHealthyBaselineDiagnostic } from '../src/ai/baselineDiagnostics.js';

const secret = 'test-only-diagnostic-secret';
const baselinePersona = 'BASE_PERSONA_BEGIN_7K4P\n这是一个临时、无害的健康基线测试角色。\nBASE_PERSONA_END_7K4P';
const abnormalPersona = '诊断标记_A01正文诊断标记_A11';

async function saveBaseline(kv, pre, settings = { model: 'same-model' }, budgetMs = 200) {
    return runHealthyBaselineDiagnostic({
        requestId: 'healthy', kv, settings, maxTokens: 100,
        diagnosticSecret: secret, budgetMs,
        messages: [{ role: 'system', content: pre + baselinePersona }, { role: 'user', content: 'hi' }],
    });
}

async function compare(kv, pre, settings = { model: 'same-model' }, budgetMs = 200) {
    return runHealthyBaselineDiagnostic({
        requestId: 'abnormal', kv, settings, maxTokens: 100,
        diagnosticSecret: secret, budgetMs,
        messages: [{ role: 'system', content: pre + abnormalPersona }, { role: 'user', content: 'hi' }],
    });
}

test('baseline KV record contains only anonymous summaries and a short TTL', async () => {
    const kv = new MemoryKvStore();
    const privateText = 'TOP-SECRET-PRESET '.repeat(2000);
    const result = await saveBaseline(kv, privateText);
    const stored = await kv.get('diag:healthy-baseline:v1');
    assert.equal(result.profile, 'healthy_baseline');
    assert.equal(result.ttlSeconds, 900);
    assert.equal(stored.includes('TOP-SECRET-PRESET'), false);
    assert.equal(stored.includes(secret), false);
    assert.equal(stored.includes('same-model'), false);
});

test('peripheral fingerprint is a separate privacy-safe event available before deep comparison', async () => {
    const privateSetting = 'PRIVATE-API-KEY-VALUE';
    const result = await buildPeripheralFingerprintDiagnostic({
        requestId: 'fingerprint-first', diagnosticSecret: secret, maxTokens: 100,
        settings: { model: 'same-model', apiKey: privateSetting },
        messages: [{ role: 'system', content: baselinePersona }],
    });
    assert.equal(result.event, 'generate_peripheral_fingerprint');
    assert.equal(result.profile, 'healthy_baseline');
    assert.equal(JSON.stringify(result).includes(privateSetting), false);
    assert.match(result.peripheralFingerprint, /^[0-9a-f]{64}$/);
});

test('proves healthy + extra with character-exact boundary', async () => {
    const kv = new MemoryKvStore();
    const healthy = 'normal-rule '.repeat(5000);
    await saveBaseline(kv, healthy);
    const result = await compare(kv, healthy + 'EXTRA'.repeat(10000));
    assert.equal(result.relation, 'healthy + extra');
    assert.equal(result.exactBoundary, true);
    assert.equal(result.candidateStart, healthy.length);
    assert.equal(result.healthyChunkCoverage, 1);
});

test('proves extra + healthy with character-exact boundary', async () => {
    const kv = new MemoryKvStore();
    const healthy = 'normal-rule '.repeat(5000);
    const extra = 'EXTRA'.repeat(10000);
    await saveBaseline(kv, healthy);
    const result = await compare(kv, extra + healthy);
    assert.equal(result.relation, 'extra + healthy');
    assert.equal(result.exactBoundary, true);
    assert.equal(result.candidateEnd, extra.length);
});

test('A + extra + B remains a non-exact candidate and never mutates input', async () => {
    const kv = new MemoryKvStore();
    const a = 'alpha stable context '.repeat(3000);
    const b = 'omega stable rules '.repeat(3000);
    const extra = 'unexpected generated template '.repeat(3000);
    const healthy = a + b;
    await saveBaseline(kv, healthy);
    const content = a + extra + b + abnormalPersona;
    const messages = [{ role: 'system', content }, { role: 'user', content: 'hi' }];
    const before = JSON.stringify(messages);
    const result = await runHealthyBaselineDiagnostic({
        requestId: 'middle', kv, settings: { model: 'same-model' }, maxTokens: 100,
        messages, diagnosticSecret: secret, budgetMs: 500,
    });
    assert.match(result.relation, /candidate|insufficient/);
    assert.equal(result.exactBoundary, false);
    assert.equal(result.safeHotfixEligible, false);
    assert.equal(JSON.stringify(messages), before);
});

test('peripheral mismatch blocks eligibility', async () => {
    const kv = new MemoryKvStore();
    const healthy = 'normal '.repeat(1000);
    await saveBaseline(kv, healthy, { model: 'model-a' });
    const result = await compare(kv, healthy + 'extra', { model: 'model-b' });
    assert.equal(result.peripheralFingerprintMatch, false);
    assert.equal(result.safeHotfixEligible, false);
});

test('6.2M comparison obeys CPU budget and leaves a partial anonymous result', async () => {
    const kv = new MemoryKvStore();
    const healthy = 'normal '.repeat(20_000);
    await saveBaseline(kv, healthy, undefined, 500);
    const huge = 'function rule { context } '.repeat(300_000).slice(0, 6_200_000);
    const started = performance.now();
    const result = await compare(kv, huge, undefined, 5);
    const elapsed = performance.now() - started;
    assert.equal(result.profile, 'abnormal_marker');
    assert.equal(result.safeHotfixEligible, false);
    assert.ok(elapsed < 150);
    assert.equal(JSON.stringify(result).includes('function rule'), false);
});
