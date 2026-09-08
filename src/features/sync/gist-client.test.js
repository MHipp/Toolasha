import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    GistError,
    MANIFEST_FILE,
    chunkPayload,
    chunkFileName,
    chunkIndexFromName,
    findSyncGist,
    readSyncGist,
    writeSyncGist,
} from './gist-client.js';

/** Requests the fake transport saw, newest last */
let calls;
/** Queued responses, consumed in order */
let responses;

beforeEach(() => {
    calls = [];
    responses = [];
    globalThis.GM_xmlhttpRequest = (options) => {
        calls.push(options);
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected request to ${options.url}`);
        if (next.networkError) {
            options.onerror();
            return;
        }
        options.onload({
            status: next.status ?? 200,
            responseText: typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}),
            responseHeaders: Object.entries(next.headers || {})
                .map(([name, value]) => `${name}: ${value}`)
                .join('\r\n'),
        });
    };
});

afterEach(() => {
    delete globalThis.GM_xmlhttpRequest;
});

describe('chunkPayload', () => {
    test('splits at the ceiling and rejoins to the original', () => {
        const text = 'x'.repeat(2500);
        const chunks = chunkPayload(text, 1000);
        expect(chunks).toHaveLength(3);
        expect(chunks.join('')).toBe(text);
    });

    test('never splits a surrogate pair', () => {
        // Each emoji is two code units, so a ceiling of 3 would land mid-pair
        const text = '😀😀😀';
        const chunks = chunkPayload(text, 3);
        expect(chunks.join('')).toBe(text);
        for (const chunk of chunks) expect([...chunk].every((char) => char === '😀')).toBe(true);
    });

    test('an empty payload is still one chunk, because a gist file cannot be absent', () => {
        expect(chunkPayload('')).toEqual(['']);
    });

    test('names sort in gist order', () => {
        expect([chunkFileName(10), chunkFileName(2)].sort()).toEqual([chunkFileName(2), chunkFileName(10)]);
    });
});

/**
 * Classification, from responses shaped like the ones GitHub actually sends.
 *
 * Each fixture below is a real response shape: the status, the headers the API
 * documents, and the JSON body with its `message` and `documentation_url`. The
 * point of testing them whole rather than calling a classifier with a bare
 * status is that the hard cases are precisely the ones where the status is not
 * enough — a secondary rate limit and a missing scope are both a 403, and only
 * the headers and the documentation URL tell them apart.
 */
describe('error classification', () => {
    test('401 is an auth problem, and the message mentions the gist scope', async () => {
        responses.push({
            status: 401,
            headers: { 'X-RateLimit-Remaining': '59' },
            body: {
                message: 'Bad credentials',
                documentation_url: 'https://docs.github.com/rest',
                status: '401',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('auth');
        expect(error.message).toContain('gist');
        expect(error.githubMessage).toBe('Bad credentials');
    });

    test('403 with no quota left is the primary rate limit, with a reset time', async () => {
        const reset = Math.floor(Date.now() / 1000) + 600;
        responses.push({
            status: 403,
            headers: {
                'X-RateLimit-Limit': '5000',
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': String(reset),
                'X-RateLimit-Resource': 'core',
            },
            body: {
                message:
                    'API rate limit exceeded for user ID 1234. If you reach out to GitHub Support for help, please include the request ID.',
                documentation_url:
                    'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-primary-rate-limits',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('rate-limit');
        expect(error.resetAt).toBeInstanceOf(Date);
        expect(error.message).toContain('hourly quota');
    });

    test('403 with quota to spare and a Retry-After is the secondary limit, not a scope problem', async () => {
        responses.push({
            status: 403,
            headers: { 'X-RateLimit-Remaining': '4987', 'Retry-After': '60' },
            body: {
                message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
                documentation_url:
                    'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('rate-limit');
        // No X-RateLimit-Reset on a secondary limit — Retry-After is the clock
        expect(error.resetAt).toBeInstanceOf(Date);
        expect(error.message).toContain('too quickly');
    });

    test('403 with quota remaining and no rate-limit signal is a scope problem', async () => {
        responses.push({
            status: 403,
            headers: { 'X-RateLimit-Remaining': '4000' },
            body: {
                message: 'Resource not accessible by personal access token',
                documentation_url: 'https://docs.github.com/rest/gists/gists#list-gists-for-the-authenticated-user',
            },
        });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('auth');
        expect(error.message).toContain('scope');
    });

    test('a 429 is a rate limit even with no headers to prove it', async () => {
        responses.push({ status: 429, body: {} });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
    });

    test('the prose is only consulted when no header or documentation URL decides', async () => {
        // No remaining count, no Retry-After, no documentation_url — all that is
        // left is what GitHub wrote, which is the last resort and still enough
        responses.push({ status: 403, body: { message: 'You have triggered an abuse detection mechanism.' } });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
    });

    test('404 says the gist is gone', async () => {
        responses.push({
            status: 404,
            body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/gists/gists#get-a-gist' },
        });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'not-found' });
    });

    test('a 422 whose validation errors are about size reads as too large', async () => {
        responses.push({
            status: 422,
            body: {
                message: 'Validation Failed',
                errors: [{ resource: 'Gist', code: 'custom', field: 'files', message: 'is too large' }],
                documentation_url: 'https://docs.github.com/rest/gists/gists#update-a-gist',
            },
        });
        await expect(writeSyncGist('tok', null, { chunks: 1 }, ['data'])).rejects.toMatchObject({
            kind: 'too-large',
        });
    });

    test('a 422 about something other than size does not send the reader off to shrink a payload', async () => {
        responses.push({
            status: 422,
            body: {
                message: 'Validation Failed',
                errors: [{ resource: 'Gist', code: 'missing_field', field: 'files' }],
            },
        });
        const error = await writeSyncGist('tok', null, { chunks: 1 }, ['data']).catch((caught) => caught);
        expect(error.kind).toBe('http');
        expect(error.message).toContain('Gist.files');
    });

    test('a bare 422 with nothing structured still reads as too large, which is what it always is', async () => {
        responses.push({ status: 422, body: {} });
        await expect(writeSyncGist('tok', null, { chunks: 1 }, ['data'])).rejects.toMatchObject({
            kind: 'too-large',
        });
    });

    test('a 5xx says GitHub is at fault and to come back later', async () => {
        responses.push({ status: 502, body: '<html>Bad gateway</html>' });
        const error = await findSyncGist('tok').catch((caught) => caught);
        expect(error.kind).toBe('http');
        expect(error.message).toContain('502');
        // An HTML body is not JSON; classification must survive that
        expect(error.githubMessage).toBe('');
    });

    test('a dead network is offline, not an HTTP failure', async () => {
        responses.push({ networkError: true });
        await expect(findSyncGist('tok')).rejects.toMatchObject({ kind: 'offline' });
    });

    test('a missing token fails before any request is made', async () => {
        await expect(findSyncGist('')).rejects.toMatchObject({ kind: 'auth' });
        expect(calls).toHaveLength(0);
    });
});

describe('token handling', () => {
    test('the token travels in a header and never in the URL', async () => {
        responses.push({ status: 200, body: [] });
        await findSyncGist('ghp_secret');
        expect(calls[0].url).not.toContain('ghp_secret');
        expect(calls[0].headers.Authorization).toBe('Bearer ghp_secret');
    });

    test('an error message never carries the token', async () => {
        responses.push({ status: 500, body: {} });
        const error = await findSyncGist('ghp_secret').catch((caught) => caught);
        expect(error).toBeInstanceOf(GistError);
        expect(JSON.stringify({ message: error.message })).not.toContain('ghp_secret');
    });
});

describe('findSyncGist', () => {
    test('recognises a sync gist by its manifest file', async () => {
        responses.push({
            status: 200,
            body: [
                { id: 'other', files: { 'notes.md': {} } },
                { id: 'ours', files: { [MANIFEST_FILE]: {} } },
            ],
        });
        expect(await findSyncGist('tok')).toBe('ours');
    });

    test('returns null when the account has none', async () => {
        responses.push({ status: 200, body: [{ id: 'other', files: { 'notes.md': {} } }] });
        expect(await findSyncGist('tok')).toBeNull();
    });
});

describe('readSyncGist', () => {
    test('reassembles chunks in manifest order', async () => {
        responses.push({
            status: 200,
            body: {
                updated_at: '2026-01-01T00:00:00Z',
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ toolashaSync: 1, chunks: 2, exportedAt: 'T' }) },
                    [chunkFileName(0)]: { content: '{"a":' },
                    [chunkFileName(1)]: { content: '1}' },
                },
            },
        });
        const { payload, manifest } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('{"a":1}');
        expect(manifest.exportedAt).toBe('T');
    });

    test('a manifest field this build does not know is passed through, not rejected', async () => {
        // The compatibility guarantee the ordering counter rests on: the gate
        // below is `toolashaSync` and `chunks`, and everything else in the
        // manifest is handed to the caller as it came. A build that predates a
        // field reads the gist exactly as it always did — which is why the
        // counter lives here rather than in the payload
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: {
                        content: JSON.stringify({ toolashaSync: 1, chunks: 1, exportedAt: 'T', somethingNew: 9 }),
                    },
                    [chunkFileName(0)]: { content: '{"a":1}' },
                },
            },
        });

        const { payload, manifest } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('{"a":1}');
        expect(manifest.exportedAt).toBe('T');
        expect(manifest.somethingNew).toBe(9);
    });

    test('follows raw_url for a file the API truncated', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ toolashaSync: 1, chunks: 1 }) },
                    [chunkFileName(0)]: { truncated: true, raw_url: 'https://gist.example/raw', content: 'partial' },
                },
            },
        });
        responses.push({ status: 200, body: 'the-whole-thing' });

        const { payload } = await readSyncGist('tok', 'abc');
        expect(payload).toBe('the-whole-thing');
        expect(calls[1].url).toBe('https://gist.example/raw');
    });

    test('a gist without a manifest is not ours', async () => {
        responses.push({ status: 200, body: { files: { 'notes.md': { content: 'hi' } } } });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'parse' });
    });

    test('a manifest file replaced by a hand-pasted backup is named for what it is', async () => {
        // Valid JSON, but no toolashaSync marker and no chunk count — exactly
        // what pasting a backup file over the manifest produces
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ formatVersion: 1, stores: { settings: {} } }) },
                },
            },
        });
        const error = await readSyncGist('tok', 'abc').catch((caught) => caught);
        expect(error.kind).toBe('parse');
        expect(error.message).toContain('hand');
    });

    test('a manifest that is not JSON says which gist to look at', async () => {
        responses.push({
            status: 200,
            body: { files: { [MANIFEST_FILE]: { content: 'this is not json' } } },
        });
        const error = await readSyncGist('tok', 'gist-xyz').catch((caught) => caught);
        expect(error.kind).toBe('parse');
        expect(error.message).toContain('gist-xyz');
    });

    test('a transport failure while reading the manifest keeps its own kind', async () => {
        // Truncated manifest forces a raw_url refetch; that refetch failing
        // with 401 must surface as auth, not as a corrupt manifest
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { truncated: true, raw_url: 'https://gist.example/raw', content: 'part' },
                },
            },
        });
        responses.push({ status: 401, body: {} });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'auth' });
    });

    test('a missing chunk fails loudly rather than returning half a backup', async () => {
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { content: JSON.stringify({ toolashaSync: 1, chunks: 2 }) },
                    [chunkFileName(0)]: { content: 'half' },
                },
            },
        });
        await expect(readSyncGist('tok', 'abc')).rejects.toMatchObject({ kind: 'parse' });
    });
});

describe('writeSyncGist', () => {
    test('creates a private gist when there is no id', async () => {
        responses.push({ status: 201, body: { id: 'new-id', updated_at: 'T' } });
        const result = await writeSyncGist('tok', null, { chunks: 1 }, ['data']);
        expect(result.id).toBe('new-id');
        expect(calls[0].method).toBe('POST');
        expect(JSON.parse(calls[0].data).public).toBe(false);
    });

    test('patches an existing gist rather than making a second one', async () => {
        responses.push({ status: 200, body: { files: {} } });
        responses.push({ status: 200, body: { id: 'abc', updated_at: 'T' } });
        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']);
        expect(calls[1].method).toBe('PATCH');
        expect(calls[1].url).toContain('/gists/abc');
    });

    test('deletes every orphaned chunk the gist actually holds, not the number this device wrote', async () => {
        // The gist grew to six chunks because another device pushed more than
        // this one ever has; the local hint says three
        responses.push({
            status: 200,
            body: {
                files: {
                    [MANIFEST_FILE]: { size: 100 },
                    ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((index) => [chunkFileName(index), { size: 10 }])),
                },
            },
        });
        responses.push({ status: 200, body: { id: 'abc' } });

        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data'], 3);

        const { files } = JSON.parse(calls[1].data);
        expect(files[chunkFileName(0)]).toEqual({ content: 'data' });
        for (const index of [1, 2, 3, 4, 5]) expect(files[chunkFileName(index)]).toBeNull();
    });

    test('a push that loses the race retries with a fresh listing and wins the next one', async () => {
        vi.useFakeTimers();
        try {
            responses.push({ status: 200, body: { files: {} } });
            responses.push({ status: 409, body: { message: 'Conflict' } });
            responses.push({ status: 200, body: { files: {} } });
            responses.push({ status: 200, body: { id: 'abc', updated_at: 'T2' } });

            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']);
            await vi.advanceTimersByTimeAsync(3000);
            const result = await pending;

            expect(result.id).toBe('abc');
            // Four calls: list, losing PATCH, fresh list, winning PATCH
            expect(calls).toHaveLength(4);
            expect(calls[2].method).toBe('GET');
            expect(calls[3].method).toBe('PATCH');
        } finally {
            vi.useRealTimers();
        }
    });

    test('a conflict that never clears is surfaced as one, after its retries', async () => {
        vi.useFakeTimers();
        try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                responses.push({ status: 200, body: { files: {} } });
                responses.push({ status: 409, body: { message: 'Conflict' } });
            }

            const pending = writeSyncGist('tok', 'abc', { chunks: 1 }, ['data']).catch((caught) => caught);
            await vi.advanceTimersByTimeAsync(10_000);
            const error = await pending;

            expect(error).toBeInstanceOf(GistError);
            expect(error.kind).toBe('conflict');
            expect(calls).toHaveLength(6);
        } finally {
            vi.useRealTimers();
        }
    });

    test('falls back to the remembered count when the gist cannot be listed', async () => {
        responses.push({ status: 500, body: {} });
        responses.push({ status: 200, body: { id: 'abc' } });

        await writeSyncGist('tok', 'abc', { chunks: 1 }, ['data'], 3);

        const { files } = JSON.parse(calls[1].data);
        expect(files[chunkFileName(1)]).toBeNull();
        expect(files[chunkFileName(2)]).toBeNull();
    });

    test('counts files it is leaving in place towards the gist ceiling', async () => {
        // A file that is not ours and not a chunk survives the write, and is
        // just as real to the API's limit as the bytes being uploaded
        responses.push({ status: 200, body: { files: { 'notes.md': { size: 8_900_000 } } } });

        await expect(writeSyncGist('tok', 'abc', {}, ['x'.repeat(200_000)])).rejects.toMatchObject({
            kind: 'too-large',
        });
        // Listed, then refused — no upload spent
        expect(calls).toHaveLength(1);
    });

    test('refuses a payload too large for one gist before spending the upload', async () => {
        const huge = ['x'.repeat(9_000_001)];
        await expect(writeSyncGist('tok', null, {}, huge)).rejects.toMatchObject({ kind: 'too-large' });
        expect(calls).toHaveLength(0);
    });
});

describe('chunkIndexFromName', () => {
    test('reads the index back out of a chunk file name', () => {
        expect(chunkIndexFromName(chunkFileName(0))).toBe(0);
        expect(chunkIndexFromName(chunkFileName(42))).toBe(42);
    });

    test('is null for anything that is not a chunk file', () => {
        expect(chunkIndexFromName(MANIFEST_FILE)).toBeNull();
        expect(chunkIndexFromName('toolasha-data-notes.json')).toBeNull();
        expect(chunkIndexFromName('notes.md')).toBeNull();
        expect(chunkIndexFromName(undefined)).toBeNull();
    });
});
