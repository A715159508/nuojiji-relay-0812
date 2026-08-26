// 服务端 AI 调用 —— 复刻 APP 本地路径的非流式行为（含主→副 fallback、429 退避）。
// 永远 stream:false（中继不需要流式，结果整条进 outbox）。

import { getApiConfig } from './apiConfigs.js';
import { buildChatEndpoint, buildApiHeaders, buildChatRequestBody, assertSafeApiUrl } from './requestBuilder.js';

const REQUEST_TIMEOUT_MS = 180_000;

async function callOnce({ apiUrl, apiKey, model, apiType, messages, temperature, reasoningEffort, maxTokens }) {
    assertSafeApiUrl(apiUrl);
    const endpoint = buildChatEndpoint(apiUrl);
    const headers = buildApiHeaders(apiUrl, apiKey);
    // ⚠️ 用流式调 AI（stream:true）：部分 AI 代理（如 gemini 反代）对「非流式 + 图片」会 500，
    //    流式正常。后端在请求内读完整个 SSE 流、把 delta 拼成完整 content 再返回 —— 对手机端
    //    仍是「整条结果进 outbox」的非流式交付，只是后端内部走流式绕开代理的非流式限制。
    const body = buildChatRequestBody({
        apiUrl, model, messages, temperature, reasoningEffort, stream: true, maxTokens,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            const err = new Error(`AI HTTP ${res.status}: ${errText.slice(0, 500)}`);
            err.status = res.status;
            try {
                const parsed = JSON.parse(errText);
                const upstream = parsed?.error || parsed;
                err.upstreamErrorType = upstream?.type || upstream?.code || parsed?.type || parsed?.code || `http_${res.status}`;
            } catch {
                err.upstreamErrorType = `http_${res.status}`;
            }
            throw err;
        }

        const config = getApiConfig(apiType);
        const ct = res.headers.get('content-type') || '';

        // 非 SSE（代理忽略了 stream，直接返回完整 JSON）→ 按非流式解析兜底
        if (!ct.includes('text/event-stream')) {
            const rawText = await res.text();
            let data;
            try { data = JSON.parse(rawText); } catch { data = rawText; }
            const content = config.extractContent(data);
            if (content == null || content === '') {
                const err = new Error('AI returned empty content (non-stream fallback)');
                err.status = res.status;
                err.detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
                throw err;
            }
            return content;
        }

        // SSE 流式：逐行读 data:，累积 delta
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 末行可能不完整，留到下次
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') continue;
                let json;
                try { json = JSON.parse(payload); } catch { continue; }
                const delta = config.extractStreamDelta(json);
                if (delta) content += delta;
            }
        }
        if (!content || !content.trim()) {
            const err = new Error('AI returned empty content (stream)');
            err.status = res.status;
            throw err;
        }
        return content;
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一次完整生成：主 API（带 429 退避重试）→ 失败且开了副 API fallback → 副 API。
 * @returns {Promise<string>} 原始模型文本（含 tag，手机端解析）
 */
export async function runGeneration(settings, messages, maxTokens) {
    const {
        mainApiUrl, mainApiKey, mainApiModel, apiType = 'openai',
        temperature, reasoningEffort,
        autoRetryEnabled = true, maxRetries = 1, secondaryFallbackEnabled = true,
        secondaryApiUrl, secondaryApiKey, secondaryApiModel,
    } = settings || {};

    if (!mainApiUrl || !mainApiKey) throw new Error('settings.mainApiUrl / mainApiKey missing');

    const retries = autoRetryEnabled ? Math.max(0, Math.min(3, Number(maxRetries) || 0)) : 0;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
        try {
            return await callOnce({
                apiUrl: mainApiUrl, apiKey: mainApiKey, model: mainApiModel, apiType,
                messages, temperature, reasoningEffort, maxTokens,
            });
        } catch (e) {
            lastErr = e;
            // 只对 429 退避重试，其余错误立即跳出（避免重复扣费）
            if (e.status !== 429) break;
        }
    }

    // 主 API 失败 → 副 API fallback
    if (secondaryFallbackEnabled && secondaryApiUrl && secondaryApiKey) {
        try {
            return await callOnce({
                apiUrl: secondaryApiUrl, apiKey: secondaryApiKey, model: secondaryApiModel || mainApiModel, apiType,
                messages, temperature, reasoningEffort, maxTokens,
            });
        } catch (e) {
            lastErr = e;
        }
    }

    throw lastErr || new Error('AI generation failed');
}
