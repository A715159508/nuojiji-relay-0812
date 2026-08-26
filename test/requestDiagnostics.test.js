import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerateDiagnostic, buildAiResultDiagnostic } from '../src/ai/requestDiagnostics.js';

test('reports UTF-8 sizes without including message content', () => {
    const diagnostic = buildGenerateDiagnostic({
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
