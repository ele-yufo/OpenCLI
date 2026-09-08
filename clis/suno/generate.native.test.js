import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const mocks = vi.hoisted(() => ({ session: vi.fn(), captcha: vi.fn(), submit: vi.fn(), poll: vi.fn(), download: vi.fn() }));
vi.mock('./utils.js', async importOriginal => ({
    ...await importOriginal(),
    ensureSunoSession: mocks.session,
    checkSunoCaptcha: mocks.captcha,
    submitSunoGeneration: mocks.submit,
    pollSunoClips: mocks.poll,
    downloadSunoClip: mocks.download,
}));
const { generateCommand, prepareSunoNativeSimple } = await import('./generate.js');
const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const description = 'Spacious instrumental piano and cello, 60 BPM.';
const options = { prompt: description, instrumental: true, title: 'Test score', sd: true, timeout: 2 };
const payload = { mode: 'simple', model: 'chirp-fenix', weirdness: 0.5, styleWeight: 0.5, description, makeInstrumental: true };
const clips = () => ids.map(id => ({ id, title: 'Native title', status: 'complete', model_name: 'chirp-fenix', metadata: { gpt_description_prompt: description, make_instrumental: true } }));

// Browser-shaped fixture executes the production DOM reads, form preparation,
// click/capture orchestration and title persistence, without a paid request.
function browser({ model = 'v5.5', capture = true, body, entry = {}, challenge = false, noRows = false, clickError = false, saveTitle = true } = {}) {
    const dom = new JSDOM(`<button role="tab" aria-label="Simple" aria-selected="false"></button>
      <textarea maxlength="3000">previous prompt</textarea>
      <button aria-label="Clear all form inputs"></button>
      <button aria-label="Check this to generate an instrumental only song"><svg class="text-pink-500"></svg></button>
      <button aria-haspopup="menu">${model}</button><button aria-label="Create song"></button><main></main>`, { runScripts: 'outside-only', url: 'https://suno.com/create' });
    const w = dom.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    w.Element.prototype.getClientRects = function () { return this.hidden ? [] : [{}]; };
    w.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 80 });
    let submitted = false;
    let editing;
    const page = {
        dom,
        goto: vi.fn(),
        wait: vi.fn(async value => { if (typeof value === 'number') vi.advanceTimersByTime(value * 1000); }),
        evaluate: vi.fn(async js => w.eval(js)),
        startNetworkCapture: vi.fn(async () => capture),
        readNetworkCapture: vi.fn(async () => submitted ? [{
            url: 'https://studio-api-prod.suno.com/api/generate/v2-web/', method: 'POST', responseStatus: 200,
            responsePreview: JSON.stringify(body || { clips: clips() }),
            ...entry,
        }] : []),
        fillText: vi.fn(async (selector, value) => {
            const targets = w.document.querySelectorAll(selector);
            if (targets.length !== 1) throw new Error('ambiguous fill');
            targets[0].value = value;
            return { verified: targets[0].value === value };
        }),
        click: vi.fn(async selector => {
            const target = w.document.querySelector(selector);
            if (!target) throw new Error('missing selector');
            if (selector.includes('role="tab"')) target.setAttribute('aria-selected', 'true');
            else if (selector.includes('Clear all')) {
                w.document.body.insertAdjacentHTML('beforeend', '<div role="alertdialog"><h2>Clear entire form?</h2><button class="hxc-btn-variant-primary">Confirm</button><button>Cancel</button></div>');
            } else if (selector.includes('alertdialog')) {
                w.document.querySelector('textarea').value = '';
                w.document.querySelector('svg').setAttribute('class', 'text-background-tertiary');
                w.document.querySelector('[role="alertdialog"]').remove();
            } else if (selector.includes('instrumental only')) {
                const icon = target.querySelector('svg');
                icon.setAttribute('class', icon.getAttribute('class').includes('pink') ? 'text-background-tertiary' : 'text-pink-500');
            } else if (selector.includes('Create song')) {
                submitted = true;
                if (clickError) throw new Error('transport lost after click');
                if (!noRows) w.document.querySelector('main').innerHTML = ids.map(id => `<div data-testid="clip-row"><a href="/song/${id}">Native title</a><button aria-label="Edit title"></button></div>`).join('');
                if (challenge) {
                    const frame = w.document.createElement('iframe');
                    frame.src = 'https://challenges.cloudflare.com/visible-challenge';
                    w.document.body.append(frame);
                }
            } else if (selector.includes('Edit title')) {
                const row = target.parentElement;
                editing = { row, href: row.querySelector('a').getAttribute('href') };
                row.querySelector('a').remove();
                row.insertAdjacentHTML('afterbegin', '<input maxlength="80">');
            }
        }),
        pressKey: vi.fn(async key => {
            if (key === 'Enter' && saveTitle) {
                const value = editing.row.querySelector('input').value;
                editing.row.querySelector('input').remove();
                const a = w.document.createElement('a'); a.href = editing.href; a.textContent = value;
                editing.row.prepend(a);
            }
        }),
    };
    return page;
}
const createClicks = page => page.click.mock.calls.filter(([s]) => s.includes('Create song'));

beforeEach(() => {
    vi.useFakeTimers();
    mocks.session.mockReset().mockResolvedValue({ planId: 'plan-test', deviceId: 'device-test', totalCreditsAvailable: 20, breakdown: {} });
    mocks.captcha.mockReset().mockResolvedValue({ ok: true, required: true });
    mocks.submit.mockReset();
    mocks.poll.mockReset().mockImplementation(async () => clips());
    mocks.download.mockReset().mockResolvedValue({ written: [{ ok: true, format: 'metadata', file: '/tmp/test.json' }] });
});
afterEach(() => vi.useRealTimers());

describe('Suno native Create fallback', () => {
    it('runs the production required=true path, binds results, saves titles, and never POSTs via the old API', async () => {
        const page = browser();
        const rows = await generateCommand.func(page, options);
        expect(createClicks(page)).toHaveLength(1);
        expect(mocks.submit).not.toHaveBeenCalled();
        expect(mocks.poll.mock.calls[0][0]).toBe(page);
        expect(mocks.poll.mock.calls[0].slice(1)).toEqual([ids, 2, 'device-test']);
        expect(rows.map(row => row.title)).toEqual(['Test score', 'Test score']);
        expect(rows.map(row => row.link)).toEqual(ids.map(id => `🔗 https://suno.com/song/${id}`));
        const createIndex = page.click.mock.calls.findIndex(([s]) => s.includes('Create song'));
        expect(page.readNetworkCapture.mock.invocationCallOrder[0]).toBeLessThan(page.click.mock.invocationCallOrder[createIndex]);
    });
    it('continues into the existing download path for the same clip ids', async () => {
        const page = browser();
        await generateCommand.func(page, { ...options, sd: false, formats: 'metadata' });
        expect(mocks.download).toHaveBeenCalledTimes(2);
        expect(mocks.download.mock.calls.map(([, clip]) => clip.id)).toEqual(ids);
        expect(createClicks(page)).toHaveLength(1);
    });
    it.each([{ model: 'chirp-bluejay' }, { weirdness: 0.8 }, { styleWeight: 0.8 }, { mode: 'custom' }])('rejects unmapped parameters before navigation: %j', async changed => {
        const page = browser();
        await expect(prepareSunoNativeSimple(page, { ...payload, ...changed })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('rejects a stale model choice before a paid click', async () => {
        const page = browser({ model: 'v4' });
        await expect(generateCommand.func(page, options)).rejects.toThrow('read-back');
        expect(createClicks(page)).toHaveLength(0);
    });
    it('refuses when capture cannot be armed', async () => {
        const page = browser({ capture: false });
        await expect(generateCommand.func(page, options)).rejects.toThrow('no generation was submitted');
        expect(createClicks(page)).toHaveLength(0);
    });
    it.each([
        { clips: clips().map(c => ({ ...c, metadata: { ...c.metadata, gpt_description_prompt: 'different request' } })) },
        { clips: [clips()[0], clips()[0]] },
        { clips: [] },
    ])('rejects mismatched or malformed successful responses without retry: %j', async body => {
        const page = browser({ body });
        await expect(generateCommand.func(page, options)).rejects.toThrow('did not match');
        expect(createClicks(page)).toHaveLength(1);
        expect(mocks.submit).not.toHaveBeenCalled();
        expect(mocks.poll).not.toHaveBeenCalled();
    });
    it.each([{ challenge: true }, { clickError: true }, { noRows: true }])('never retries after an uncertain native write: %j', async behavior => {
        const page = browser(behavior);
        await expect(generateCommand.func(page, options)).rejects.toThrow(/Do not rerun generate/);
        expect(createClicks(page)).toHaveLength(1);
        expect(mocks.submit).not.toHaveBeenCalled();
    });
    it.each([{ responseStatus: 403 }, { responseBodyTruncated: true }, { responsePreview: undefined }, { responsePreview: '<html>not JSON</html>' }])('fails closed on unsuccessful or incomplete captures: %j', async entry => {
        const page = browser({ entry });
        await expect(generateCommand.func(page, options)).rejects.toThrow(/Do not rerun generate/);
        expect(createClicks(page)).toHaveLength(1);
        expect(mocks.submit).not.toHaveBeenCalled();
    });
    it('preserves submitted ids when later polling fails', async () => {
        mocks.poll.mockRejectedValue(new Error('poll timeout'));
        const page = browser();
        await expect(generateCommand.func(page, options)).rejects.toThrow(`Suno submitted ${ids.join(', ')}`);
        expect(createClicks(page)).toHaveLength(1);
        expect(mocks.submit).not.toHaveBeenCalled();
    });
    it('reports existing ids when title persistence fails, not a new generation request', async () => {
        const page = browser({ saveTitle: false });
        await expect(generateCommand.func(page, options)).rejects.toThrow(`Suno generated ${ids.join(', ')}`);
        expect(createClicks(page)).toHaveLength(1);
        expect(mocks.submit).not.toHaveBeenCalled();
    });
});
