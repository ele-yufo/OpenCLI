/**
 * `opencli suno generate` — submit a Suno music-generation request, wait for
 * both clips to finish, and download selected formats locally.
 *
 * Targets the /api/generate/v2-web/ endpoint (cookie auth). Each generation
 * returns 2 candidate clips by design — both are downloaded so the caller
 * can A/B them.
 *
 * Modes:
 *   - Custom (when --lyrics is provided): API receives prompt(lyrics)+tags
 *     +title+negative_tags. Use this for professional control over lyrics,
 *     structure metatags, style, and exclusions.
 *   - Simple (default): API receives a description in `prompt`; Suno picks
 *     the lyrics, tags, and title.
 *
 * Creative knobs (--weirdness / --style-weight) map directly to the
 * `metadata.control_sliders` the web UI exposes.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
    DEFAULT_SUNO_MODEL,
    SUNO_DOMAIN,
    SUNO_MODELS,
    SUNO_URL,
    checkSunoCaptcha,
    clampSlider,
    downloadSunoClip,
    ensureSunoSession,
    normalizeBooleanFlag,
    parseFormats,
    pollSunoClips,
    requirePositiveInt,
    resolveSunoOutputDir,
    submitSunoGeneration,
} from './utils.js';

import * as crypto from 'node:crypto';
import * as os from 'node:os';

function displayPath(filePath) {
    if (!filePath) return '-';
    const home = os.homedir();
    return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

// Strategy: UI_SELECTOR (visible-ui), with response capture for clip identity.
// Suno's /api/c/check can return required=true while its own Create page
// completes verification without a human challenge. Do not replay or fabricate
// verification tokens: click Create once and let the site's runtime submit.
// The bounded fallback supports Simple/V5.5/default sliders only. Other
// controls fail before submission rather than silently changing the request.
const SIMPLE_PROMPT = 'textarea[maxlength="3000"]';
const INSTRUMENTAL = 'button[aria-label="Check this to generate an instrumental only song"]';
const CREATE = 'button[aria-label="Create song"]';
const GENERATE_URL = 'https://studio-api-prod.suno.com/api/generate/v2-web/';
const CLIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nativeFailure(message, cause) {
    const failure = new CommandExecutionError(message);
    // The runtime follows cause to retain a write lease for unknown outcomes.
    failure.cause = cause;
    return failure;
}

async function createClickPoint(page) {
    if (typeof page.nativeClick !== 'function') throw new CommandExecutionError('Suno Create requires native single-click support; no generation was submitted.');
    const point = await page.evaluate(`(() => {
        const buttons = document.querySelectorAll(${JSON.stringify(CREATE)});
        if (buttons.length !== 1) return null;
        const button = buttons[0];
        if (button.disabled || getComputedStyle(button).visibility === 'hidden') return null;
        button.scrollIntoView({block: 'center', inline: 'center'});
        const r = button.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === button || button.contains(hit)) ? {x, y} : null;
    })()`);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new CommandExecutionError('Suno Create is missing, disabled, or covered; no generation was submitted.');
    }
    return point;
}

async function nativeState(page) {
    return page.evaluate(`(() => {
        const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
        const toggle = document.querySelector(${JSON.stringify(INSTRUMENTAL)});
        const icon = toggle?.querySelector('svg');
        const iconClass = icon?.getAttribute('class') || '';
        return {
            simple: document.querySelector('button[role="tab"][aria-label="Simple"]')?.getAttribute('aria-selected') === 'true',
            prompt: document.querySelector(${JSON.stringify(SIMPLE_PROMPT)})?.value,
            instrumental: iconClass.includes('text-pink-500') ? true : iconClass.includes('text-background-tertiary') ? false : null,
            models: Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).filter(e => visible(e) && /^v[0-9]/.test(e.innerText.trim())).map(e => e.innerText.trim()),
            clear: !!document.querySelector('button[aria-label="Clear all form inputs"]'),
            enabled: document.querySelector(${JSON.stringify(CREATE)})?.disabled === false,
            ids: Array.from(document.querySelectorAll('[data-testid="clip-row"] a[href^="/song/"]')).map(e => e.getAttribute('href').split('/').pop()),
            manualChallenge: Array.from(document.querySelectorAll('iframe')).some(e => {
                const r = e.getBoundingClientRect();
                return visible(e) && r.width > 30 && r.height > 30 &&
                    /challenges\\.cloudflare\\.com|hcaptcha\\.com|recaptcha/.test(e.src);
            }),
        };
    })()`);
}

export async function prepareSunoNativeSimple(page, payload) {
    if (payload.mode !== 'simple' || payload.model !== DEFAULT_SUNO_MODEL || payload.weirdness !== 0.5 || payload.styleWeight !== 0.5) {
        throw new CommandExecutionError(
            'Suno requested webpage verification. The native fallback currently supports Simple mode, V5.5, and default sliders only; no generation was submitted.',
            `Use the requested advanced controls at ${SUNO_URL}/create. Completing verification once does not guarantee token-free API requests will work.`,
        );
    }
    if (payload.description.length > 3000) {
        throw new ArgumentError('Suno Simple mode allows at most 3000 characters; no generation was submitted.');
    }
    await page.goto(`${SUNO_URL}/create`);
    await page.wait({ selector: 'button[role="tab"][aria-label="Simple"]', timeout: 30 });
    await page.click('button[role="tab"][aria-label="Simple"]');
    await page.wait({ selector: SIMPLE_PROMPT, timeout: 10 });
    const initial = await nativeState(page);
    if (initial.manualChallenge) throw new CommandExecutionError('Suno shows a human verification challenge. Complete it in the Create tab; no generation was submitted.');
    if (initial.clear) {
        await page.click('button[aria-label="Clear all form inputs"]');
        await page.wait(0.2);
        const confirmClear = await page.evaluate(`(() => {
            const dialogs = Array.from(document.querySelectorAll('[role="alertdialog"]')).filter(e => e.getClientRects().length);
            const d = dialogs.length === 1 ? dialogs[0] : null;
            return d?.querySelector('h2')?.textContent === 'Clear entire form?' &&
                d.querySelector('button.hxc-btn-variant-primary')?.textContent === 'Confirm';
        })()`);
        if (!confirmClear) throw new CommandExecutionError('Suno clear-form confirmation changed; no generation was submitted.');
        await page.click('[role="alertdialog"] button.hxc-btn-variant-primary');
        await page.wait(0.3);
        const cleared = await nativeState(page);
        if (cleared.prompt !== '') throw new CommandExecutionError('Suno did not clear the previous form; no generation was submitted.');
    }
    const filled = await page.fillText(SIMPLE_PROMPT, payload.description);
    if (!filled?.verified) throw new CommandExecutionError('Suno description did not read back correctly; no generation was submitted.');
    await page.wait(0.2);
    const state = await nativeState(page);
    if (state.instrumental === null) throw new CommandExecutionError('Suno instrumental control changed; no generation was submitted.');
    if (state.instrumental !== payload.makeInstrumental) await page.click(INSTRUMENTAL);
    let final;
    for (let attempt = 0; attempt < 10; attempt++) {
        await page.wait(0.2);
        final = await nativeState(page);
        if (final.instrumental === payload.makeInstrumental && final.enabled) break;
    }
    if (!final.simple || final.prompt !== payload.description || final.instrumental !== payload.makeInstrumental || final.models.length !== 1 || final.models[0] !== 'v5.5' || !final.enabled) {
        throw new CommandExecutionError('Suno native form read-back did not match the requested mode, description, instrumental state, or V5.5 model; no generation was submitted.');
    }
    return final.ids;
}

export async function submitSunoNativeSimple(page, payload, timeout) {
    const previousIds = new Set(await prepareSunoNativeSimple(page, payload));
    if (typeof page.startNetworkCapture !== 'function' || !await page.startNetworkCapture('/api/generate/v2-web/')) {
        throw new CommandExecutionError('Suno native generation needs browser response capture; no generation was submitted. Update the OpenCLI browser extension.');
    }
    await page.readNetworkCapture(); // Drain old requests before the only click.
    const point = await createClickPoint(page);
    const recovery = `Do not rerun generate automatically. Check ${SUNO_URL}/create or run opencli suno list, then download the existing clip ids.`;
    try {
        // page.click() may fall back to a second JS click after a lost native
        // result. Paid submission must use the no-fallback native primitive.
        await page.nativeClick(point.x, point.y);
        const deadline = Date.now() + Math.min(timeout, 90) * 1000;
        // The bridge drains in-flight captures. Wait for new visible result rows
        // before reading, so the completed response body is not lost.
        let state;
        do {
            await page.wait(1);
            state = await nativeState(page);
            if (state.manualChallenge) {
                throw new CommandExecutionError(`Suno needs human verification in the Create tab. Complete it there and check for results. ${recovery}`);
            }
            if (new Set(state.ids.filter(id => !previousIds.has(id))).size >= 2) break;
        } while (Date.now() < deadline);
        const entries = await page.readNetworkCapture();
        const responses = entries.filter(e => e?.url === GENERATE_URL && e.method === 'POST');
        if (responses.length !== 1) throw new CommandExecutionError(`Suno native submission outcome is uncertain (expected one generation response, received ${responses.length}). ${recovery}`);
        const response = responses[0];
        if (response.responseStatus !== 200 || response.responseBodyTruncated || typeof response.responsePreview !== 'string') {
            throw new CommandExecutionError(`Suno native submission response is unavailable or unsuccessful (HTTP ${response.responseStatus || 'unknown'}). ${recovery}`);
        }
        let submission;
        try { submission = JSON.parse(response.responsePreview); } catch {
            throw new CommandExecutionError(`Suno native submission returned invalid JSON. ${recovery}`);
        }
        const clips = submission?.clips;
        if (!Array.isArray(clips) || clips.length !== 2 || new Set(clips.map(c => c?.id)).size !== 2 || clips.some(c =>
            !CLIP_ID.test(c?.id || '') || previousIds.has(c.id) || !state.ids.includes(c.id) ||
            c.model_name !== payload.model || c.metadata?.gpt_description_prompt !== payload.description ||
            c.metadata?.make_instrumental !== payload.makeInstrumental)) {
            throw new CommandExecutionError(`Suno native response did not match this request's new clip identities, model, description, and instrumental state. ${recovery}`);
        }
        return submission;
    } catch (error) {
        if (error instanceof CommandExecutionError) throw error;
        // A transport/click error may occur after the site accepted the write.
        // Never fall back to an API POST or a second Create click here.
        throw nativeFailure(`Suno native submission outcome is uncertain. ${recovery}`, error);
    }
}

export async function renameSunoNativeClips(page, clips, title) {
    for (const clip of clips) {
        if (!CLIP_ID.test(clip.id)) throw new CommandExecutionError('Invalid Suno clip identity for title edit.');
        const row = `[data-testid="clip-row"]:has(a[href="/song/${clip.id}"])`;
        const editor = '[data-testid="clip-row"] input[maxlength="80"]';
        try {
            await page.click(`${row} button[aria-label="Edit title"]`);
            const filled = await page.fillText(editor, title);
            if (!filled?.verified) throw new Error('title read-back');
            await page.pressKey('Enter');
            let saved = false;
            for (let attempt = 0; attempt < 10; attempt++) {
                await page.wait(0.5);
                saved = await page.evaluate(`(() => document.querySelector('a[href="/song/${clip.id}"]')?.textContent === ${JSON.stringify(title)})()`);
                if (saved) break;
            }
            if (!saved) throw new Error('title save');
            clip.title = title;
        } catch (error) {
            throw nativeFailure(`Suno generated ${clips.map(c => c.id).join(', ')} but could not verify title editing. Do not regenerate; inspect these clips at ${SUNO_URL}/create.`, error);
        }
    }
}

export const generateCommand = cli({
    site: 'suno',
    name: 'generate',
    access: 'write',
    description: 'Generate music with Suno (V5.5 chirp-fenix by default) and download clips locally',
    domain: SUNO_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    defaultFormat: 'plain',
    args: [
        { name: 'prompt', positional: true, required: false, help: 'Simple-mode description (ignored when --lyrics is provided)' },
        { name: 'lyrics', help: 'Custom-mode lyrics (with [Verse]/[Chorus] metatags). Triggers Custom mode.' },
        { name: 'tags', help: 'Custom-mode style tags (genre, BPM, instruments...). Used with --lyrics.' },
        { name: 'negative-tags', help: 'Custom-mode style exclusions (e.g. "no vocals, no autotune"). Used with --lyrics.' },
        { name: 'title', help: 'Song title (default: auto-derived from prompt)' },
        { name: 'instrumental', type: 'boolean', default: false, help: 'No vocals' },
        { name: 'model', help: `Model id: ${SUNO_MODELS.join(', ')}. Default: ${DEFAULT_SUNO_MODEL}` },
        { name: 'weirdness', help: 'Creative weirdness slider (0..1). Default: 0.5' },
        { name: 'style-weight', help: 'Style adherence slider (0..1). Default: 0.5' },
        { name: 'formats', help: 'Comma-separated download formats: mp3, m4a, wav, video, cover, metadata. Default: mp3,metadata' },
        { name: 'op', help: 'Output directory (default: ~/Music/suno)' },
        { name: 'timeout', type: 'int', default: 300, help: 'Max seconds to wait for clips to finish (default: 300)' },
        { name: 'sd', type: 'boolean', default: false, help: 'Skip download; only print clip ids and Suno URLs' },
        { name: 'confirm-paid', type: 'boolean', default: false, help: 'Required to allow paid downloads (wav). Without it, paid formats are skipped with a warning.' },
    ],
    columns: ['status', 'clip', 'title', 'files', 'link'],
    func: async (page, kwargs) => {
        const lyrics = kwargs.lyrics ? String(kwargs.lyrics) : '';
        const tags = kwargs.tags ? String(kwargs.tags) : '';
        const negativeTags = kwargs['negative-tags'] ? String(kwargs['negative-tags']) : '';
        const description = kwargs.prompt ? String(kwargs.prompt) : '';
        const titleArg = kwargs.title ? String(kwargs.title) : '';
        const model = kwargs.model ? String(kwargs.model).trim() : DEFAULT_SUNO_MODEL;
        if (!SUNO_MODELS.includes(model)) {
            throw new ArgumentError(`Unsupported --model "${model}"`, `Choices: ${SUNO_MODELS.join(', ')}`);
        }

        const isCustom = lyrics.trim() !== '';
        if (!isCustom && !description.trim()) {
            throw new ArgumentError(
                'Either provide a Simple-mode prompt as the positional argument, or pass --lyrics for Custom mode.',
                'Examples:\n  opencli suno generate "lo-fi study beat, 80 bpm"\n  opencli suno generate --lyrics "[Verse]\\n..." --tags "synthwave, 120 bpm"',
            );
        }
        if (!isCustom && (tags || negativeTags)) {
            throw new ArgumentError('--tags and --negative-tags only apply in Custom mode (alongside --lyrics).');
        }

        const requestedFormats = parseFormats(kwargs.formats);
        const confirmPaid = normalizeBooleanFlag(kwargs['confirm-paid']);
        const skipDownload = normalizeBooleanFlag(kwargs.sd);
        const PAID_FORMATS = new Set(['wav']);
        const skippedPaid = [];
        const formats = requestedFormats.filter(f => {
            if (PAID_FORMATS.has(f) && !confirmPaid) {
                skippedPaid.push(f);
                return false;
            }
            return true;
        });
        if (!skipDownload && !formats.length) {
            throw new ArgumentError('All requested formats require --confirm-paid true', 'Add --confirm-paid true or include a free format such as mp3 or metadata.');
        }
        const outputDir = resolveSunoOutputDir(kwargs.op);
        const timeout = requirePositiveInt(kwargs.timeout, '--timeout');
        const makeInstrumental = normalizeBooleanFlag(kwargs.instrumental);
        const weirdness = clampSlider(kwargs.weirdness, '--weirdness', 0.5);
        const styleWeight = clampSlider(kwargs['style-weight'], '--style-weight', 0.5);

        // Title: required by API. Auto-derive from first 60 chars of source prompt if not provided.
        const titleSource = titleArg || (isCustom ? (tags || lyrics.split('\n')[0]) : description);
        const title = titleSource.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';

        const session = await ensureSunoSession(page);
        if (!session.planId) {
            throw new CommandExecutionError(
                `Suno generation needs a resolved plan id for the user_tier field, but billing/info did not surface one for this account (subscription_type=${session.planKey}). Verify the account is active at ${SUNO_URL}/account, then retry.`,
            );
        }
        const deviceId = session.deviceId;
        const captcha = await checkSunoCaptcha(page, deviceId);
        if (!captcha?.ok) {
            throw new CommandExecutionError(
                `Suno captcha pre-flight failed${captcha?.status ? ` (HTTP ${captcha.status})` : ''}.`,
                `Open ${SUNO_URL}/create in Chrome and verify the account is ready, then retry.`,
            );
        }
        if (session.totalCreditsAvailable < 10) {
            const b = session.breakdown;
            throw new CommandExecutionError(
                `Suno generation needs ~10 credits; you have ${session.totalCreditsAvailable} (monthly ${b.monthlyRemaining}/${b.monthlyLimit} + packs ${b.purchasedPacks} + leftover ${b.pack}). Top up at ${SUNO_URL}/account.`,
            );
        }

        const transactionUuid = crypto.randomUUID();
        const createSessionToken = crypto.randomUUID();

        const payload = {
            mode: isCustom ? 'custom' : 'simple',
            model,
            title,
            lyrics,
            tags,
            negativeTags,
            description,
            makeInstrumental,
            weirdness,
            styleWeight,
            userTier: session.planId,
            createSessionToken,
            transactionUuid,
            deviceId,
        };
        const submission = captcha.required
            ? await submitSunoNativeSimple(page, payload, timeout)
            : await submitSunoGeneration(page, payload);

        if (!Array.isArray(submission.clips)) {
            throw new CommandExecutionError('Suno generation returned malformed clips payload.');
        }
        const clipIds = submission.clips.map(c => c?.id);
        if (clipIds.some(id => !id)) {
            throw new CommandExecutionError('Suno generation returned malformed clip identity.');
        }
        if (!clipIds.length) {
            throw new CommandExecutionError('Suno accepted the request but returned no clip ids.');
        }

        let clips;
        try {
            clips = await pollSunoClips(page, clipIds, timeout, deviceId);
        } catch (error) {
            if (!captcha.required) throw error;
            throw nativeFailure(`Suno submitted ${clipIds.join(', ')} but polling did not finish. Do not regenerate; inspect or download these existing ids.`, error);
        }
        const completed = clips.filter(c => c.status === 'complete');
        if (!completed.length) {
            const errors = clips.map(c => `${c.id.slice(0, 8)}:${c.status}`).join(', ');
            throw new CommandExecutionError(`All Suno clips failed (${errors}). Open ${SUNO_URL}/song/${clipIds[0]} to inspect.`);
        }

        if (captcha.required) {
            await renameSunoNativeClips(page, completed, title);
            const titledIds = completed.map(c => c.id);
            let verified = false;
            try {
                for (let attempt = 0; attempt < 5; attempt++) {
                    const persisted = await pollSunoClips(page, clipIds, timeout, deviceId);
                    if (clipIds.every(id => persisted.some(c => c.id === id)) && titledIds.every(id => persisted.find(c => c.id === id)?.title === title)) {
                        clips = persisted;
                        verified = true;
                        break;
                    }
                    await page.wait(1);
                }
            } catch (error) {
                throw nativeFailure(`Suno generated ${clipIds.join(', ')} but title persistence could not be checked. Do not regenerate; inspect these existing clips.`, error);
            }
            if (!verified) throw new CommandExecutionError(`Suno generated ${clipIds.join(', ')} but the server did not confirm the requested title. Do not regenerate; inspect these existing clips.`);
        }

        const rows = [];
        for (const clip of clips) {
            const link = `${SUNO_URL}/song/${clip.id}`;
            if (clip.status !== 'complete') {
                rows.push({
                    status: `❌ ${clip.status}`,
                    clip: clip.id.slice(0, 8),
                    title: clip.title || '(untitled)',
                    files: '-',
                    link: `🔗 ${link}`,
                });
                continue;
            }
            if (skipDownload) {
                rows.push({
                    status: '🎵 generated',
                    clip: clip.id.slice(0, 8),
                    title: clip.title || '(untitled)',
                    files: '📁 -',
                    link: `🔗 ${link}`,
                });
                continue;
            }
            const result = await downloadSunoClip(page, clip, outputDir, formats, deviceId);
            if (!result.written.some(w => w.ok)) {
                throw new CommandExecutionError(`Suno download wrote no files for clip ${clip.id}`);
            }
            const writtenSummary = result.written
                .map(w => w.ok ? `${w.format}:${displayPath(w.file)}` : `${w.format}:✗(${w.reason})`)
                .join(' | ');
            const skippedSummary = skippedPaid.length
                ? ` | skipped(needs --confirm-paid):${skippedPaid.join(',')}`
                : '';
            const anyFailed = result.written.some(w => !w.ok);
            rows.push({
                status: anyFailed ? '⚠ partial' : '✅ saved',
                clip: clip.id.slice(0, 8),
                title: clip.title || '(untitled)',
                files: `📁 ${writtenSummary}${skippedSummary}`,
                link: `🔗 ${link}`,
            });
        }
        return rows;
    },
});
