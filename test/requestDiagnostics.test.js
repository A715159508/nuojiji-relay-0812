import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerateDiagnostic, buildAiResultDiagnostic } from '../src/ai/requestDiagnostics.js';

test('reports UTF-8 sizes without including message content', async () => {
    const diagnostic = await buildGenerateDiagnostic({
        requestId: 'req-1',
        rawBodyBytes: 321,
        messages: [
            { role: 'system', content: '人设一' },
            { role: 'user', content: 'hi' },
        ],
    });

    assert.equal(diagnostic.bodyBytes, 321);
    assert.equal(diagnostic.messagesLength, 2);
    assert.deepEqual(diagnostic.messageSizes, [
        { index: 0, role: 'system', chars: 3, bytes: 9 },
        { index: 1, role: 'user', chars: 2, bytes: 2 },
    ]);
    assert.equal(diagnostic.systemChars, 3);
    assert.equal(diagnostic.systemBytes, 9);
    assert.equal(JSON.stringify(diagnostic).includes('人设一'), false);
});

test('reports data URL metadata and hash without the Base64 body', async () => {
    const block = 'iVBORw0KGgo' + 'A'.repeat(1_000_100);
    const diagnostic = await buildGenerateDiagnostic({
        requestId: 'req-base64',
        rawBodyBytes: block.length,
        messages: [{ role: 'system', content: `{"avatar":"data:image/png;base64,${block}"}` }],
    });
    const analysis = diagnostic.largestSystemAnalysis;
    assert.equal(analysis.markers.dataImage, true);
    assert.equal(analysis.millionScaleBase64, true);
    assert.equal(analysis.base64Blocks[0].prefixType, 'image/png');
    assert.equal(analysis.base64Blocks[0].imageSignature, 'png');
    assert.equal(analysis.base64Blocks[0].sha256.length, 64);
    assert.equal(JSON.stringify(diagnostic).includes(block.slice(0, 100)), false);
});

test('reports JSON field paths and sizes without values', async () => {
    const privateValue = 'secret-value-'.repeat(100);
    const diagnostic = await buildGenerateDiagnostic({
        requestId: 'req-json',
        rawBodyBytes: 999,
        messages: [{ role: 'system', content: JSON.stringify({ persona: privateValue, items: ['x', 'y'] }) }],
    });
    const structure = diagnostic.largestSystemAnalysis.jsonStructure;
    assert.equal(structure.parseable, true);
    assert.equal(structure.largestStrings[0].path, '$.persona');
    assert.equal(structure.largestStrings[0].chars, privateValue.length);
    assert.equal(structure.largestArrays[0].path, '$.items');
    assert.equal(JSON.stringify(diagnostic).includes(privateValue), false);
});

test('reports only safe AI error metadata', () => {
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
