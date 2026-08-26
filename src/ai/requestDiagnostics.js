const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

function contentText(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    try { return JSON.stringify(content); } catch { return '[unserializable]'; }
}

export function buildGenerateDiagnostic({ requestId, rawBodyBytes, messages }) {
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
