import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGenerateEntryDiagnostic,
    buildMarkerOffsetDiagnostic,
    buildPrePersonaFingerprintDiagnostic,
    buildGenerateDiagnostic,
    buildAiResultDiagnostic,
} from '../src/ai/requestDiagnostics.js';

test('entry diagnostic is immediate and excludes message content', () => {
    const diagnostic = buildGenerateEntryDiagnostic({
        requestId: 'req-1',
        rawBodyBytes: 321,
        messages: [{ role: 'system', content: '人设一' }, { role: 'user', content: 'hi' }],
    });
    assert.equal(diagnostic.event, 'generate_received');
    assert.equal(diagnostic.bodyBytes, 321);
    assert.equal(diagnostic.messagesLength, 2);
    assert.equal(diagnostic.firstSystemChars, 3);
    assert.deepEqual(diagnostic.roles, ['system', 'user']);
    assert.equal(JSON.stringify(diagnostic).includes('人设一'), false);
});

test('marker diagnostic uses safe offsets and detects missing or duplicate markers', () => {
    const content = `prefix诊断标记_A01middle诊断标记_A02tail诊断标记_A02诊断标记_A04`;
    const diagnostic = buildMarkerOffsetDiagnostic({ requestId: 'markers', messages: [{ role: 'system', content }] });
    assert.equal(diagnostic.event, 'generate_marker_offsets');
    assert.equal(diagnostic.markers[0].firstOffset, 6);
    assert.equal(diagnostic.markers[1].distanceFromPrevious, '诊断标记_A01middle'.length);
    assert.equal(diagnostic.markers[1].count, 2);
    assert.equal(diagnostic.markers[2].found, false);
    assert.deepEqual(diagnostic.duplicated, ['诊断标记_A02']);
    assert.ok(diagnostic.missing.includes('诊断标记_A03'));
    assert.equal(JSON.stringify(diagnostic).includes('prefix'), false);
    assert.equal(JSON.stringify(diagnostic).includes('middle'), false);
});

test('marker diagnostic is silent for ordinary requests', () => {
    assert.equal(buildMarkerOffsetDiagnostic({ requestId: 'none', messages: [{ role: 'system', content: 'ordinary private prompt' }] }), null);
});

test('pre-persona fingerprint locates marker persona without logging content', async () => {
    const privatePrefix = 'PRIVATE-PREFIX '.repeat(500);
    const content = `${privatePrefix}诊断标记_A01完整正文诊断标记_A11private suffix`;
    const diagnostic = await buildPrePersonaFingerprintDiagnostic({
        requestId: 'pre-marker', messages: [{ role: 'system', content }], budgetMs: 100,
    });
    assert.equal(diagnostic.profile, 'abnormal_marker');
    assert.equal(diagnostic.prePersonaChars, privatePrefix.length);
    assert.equal(diagnostic.personaFound, true);
    assert.equal(diagnostic.completed, true);
    assert.equal(JSON.stringify(diagnostic).includes('PRIVATE-PREFIX'), false);
    assert.equal(JSON.stringify(diagnostic).includes('完整正文'), false);
});

test('pre-persona fingerprint obeys a tiny budget on 6.2M input', async () => {
    const content = `${'function template rule { return context; } '.repeat(160_000).slice(0, 6_200_000)}诊断标记_A01正文诊断标记_A11`;
    const started = performance.now();
    const diagnostic = await buildPrePersonaFingerprintDiagnostic({
        requestId: 'pre-large', messages: [{ role: 'system', content }], budgetMs: 1,
    });
    const elapsed = performance.now() - started;
    assert.equal(diagnostic.profile, 'abnormal_marker');
    assert.ok(diagnostic.sampledChars <= 48 * 4096);
    assert.ok(elapsed < 100);
    assert.equal(JSON.stringify(diagnostic).includes('正文'), false);
});

test('sampled structure diagnostic classifies vector-like JSON without leaking values', async () => {
    const privateText = 'PRIVATE-PERSONA-VALUE';
    const numeric = Array.from({ length: 256 }, (_, index) => (index / 10).toFixed(1)).join(',');
    const unit = `{"persona":"${privateText}","embedding":[${numeric}],"history":[]}\n`;
    const content = unit.repeat(50);
    const diagnostic = await buildGenerateDiagnostic({
        requestId: 'fingerprint', rawBodyBytes: content.length,
        messages: [{ role: 'system', content }], budgetMs: 100,
    });
    assert.equal(diagnostic.event, 'generate_structure');
    assert.equal(diagnostic.completed, true);
    assert.equal(diagnostic.classification.likelyVectorOrTokenArray, true);
    assert.equal(diagnostic.classification.likelyJsonLikeSerialization, true);
    assert.ok(diagnostic.keyCounts.persona > 0);
    assert.ok(diagnostic.keyCounts.embedding > 0);
    assert.ok(diagnostic.samples.length >= 1);
    assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
});

test('large input work is bounded and returns partial metadata under a tiny budget', async () => {
    const privateText = 'NEVER-LOG-THIS';
    const content = (`{"content":"${privateText}","data":[1,2,3]} `).repeat(200_000).slice(0, 6_511_182);
    const started = performance.now();
    const diagnostic = await buildGenerateDiagnostic({
        requestId: 'large', rawBodyBytes: content.length,
        messages: [{ role: 'system', content }], budgetMs: 1,
    });
    const elapsed = performance.now() - started;
    assert.ok(diagnostic.sampledChars <= 9 * 4 * 1024);
    assert.ok(elapsed < 100);
    assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
});

test('uniform sampling covers beginning, middle, and end of a huge system', async () => {
    const content = 'a'.repeat(6_511_182);
    const diagnostic = await buildGenerateDiagnostic({
        requestId: 'coverage', rawBodyBytes: content.length,
        messages: [{ role: 'system', content }], budgetMs: 100,
    });
    assert.equal(diagnostic.samples[0].start, 0);
    assert.ok(diagnostic.samples.some((sample) => sample.start > content.length / 3 && sample.start < content.length * 2 / 3));
    assert.ok(diagnostic.samples.some((sample) => sample.start + sample.length === content.length));
});

test('AI result diagnostics omit upstream response details', () => {
    const error = new Error('private upstream response');
    error.status = 400;
    error.upstreamErrorType = 'invalid_request_error';
    const diagnostic = buildAiResultDiagnostic('req-2', error);
    assert.deepEqual(
        { ok: diagnostic.ok, status: diagnostic.status, errorType: diagnostic.errorType },
        { ok: false, status: 400, errorType: 'invalid_request_error' },
    );
    assert.equal(JSON.stringify(diagnostic).includes('private upstream response'), false);
});
