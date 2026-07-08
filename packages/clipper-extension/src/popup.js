// MV3 popup script. Pulls the current tab, hands optional selection extraction
// off to a content script via chrome.scripting.executeScript, then POSTs HTML
// (or selection) to the Synaipse server on the configured host. When an API
// token is stored (Options page), it is sent as `Authorization: Bearer …`.

const DEFAULT_SERVER = 'http://localhost:3001';

const $ = (id) => document.getElementById(id);

const loadSettings = async () => {
    const stored = await chrome.storage.sync.get(['serverUrl', 'apiToken']);
    return {
        serverUrl: stored.serverUrl || DEFAULT_SERVER,
        apiToken: stored.apiToken || ''
    };
};

const authHeader = (apiToken) =>
    apiToken.length > 0 ? {Authorization: `Bearer ${apiToken}`} : {};

const checkServer = async (serverUrl, apiToken) => {
    try {
        const response = await fetch(`${serverUrl}/api/info`, {
            method: 'GET',
            headers: {...authHeader(apiToken)}
        });
        if (response.status === 401) return {ok: false, reason: 'unauthorized'};
        if (!response.ok) return {ok: false, reason: `HTTP ${response.status}`};
        return {ok: true, reason: null};
    } catch {
        return {ok: false, reason: 'unreachable'};
    }
};

const getActiveTab = async () => {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    return tab;
};

const extractFromTab = async (tabId) => {
    const [{result}] = await chrome.scripting.executeScript({
        target: {tabId},
        func: () => {
            const selection = window.getSelection()?.toString() ?? '';
            const main = document.querySelector('article, main') ?? document.body;
            return {
                html: main.outerHTML,
                selection,
                excerpt: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
            };
        }
    });
    return result;
};

const setStatus = (el, ok, msg) => {
    el.classList.remove('ok', 'err');
    el.classList.add(ok ? 'ok' : 'err');
    el.textContent = msg;
};

const describeHealth = (serverUrl, health) => {
    if (health.ok) return `connected · ${serverUrl}`;
    if (health.reason === 'unauthorized') return `401 · check API token in Options`;
    if (health.reason === 'unreachable') return `no server at ${serverUrl}`;
    return `${health.reason} · ${serverUrl}`;
};

const init = async () => {
    const {serverUrl, apiToken} = await loadSettings();
    const tab = await getActiveTab();

    if (tab !== undefined) {
        $('title').value = tab.title ?? '';
    }

    const health = await checkServer(serverUrl, apiToken);
    setStatus($('server-status'), health.ok, describeHealth(serverUrl, health));

    $('clip').addEventListener('click', async () => {
        const button = $('clip');
        const result = $('result');
        button.disabled = true;
        result.textContent = 'Clipping…';
        result.classList.remove('ok', 'err');

        try {
            const extracted = await extractFromTab(tab.id);
            const tags = $('tags').value.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
            const selectionOnly = $('selection-only').checked && extracted.selection.length > 0;

            const payload = {
                url: tab.url,
                title: $('title').value.trim() || tab.title || 'Untitled',
                tags
            };

            if (selectionOnly) {
                payload.markdown = extracted.selection;
            } else {
                payload.html = extracted.html;
                if (extracted.selection.length > 0) payload.selection = extracted.selection;
            }

            if (extracted.excerpt.length > 0) payload.excerpt = extracted.excerpt;

            const response = await fetch(`${serverUrl}/api/clip`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeader(apiToken)
                },
                body: JSON.stringify(payload)
            });

            if (response.status === 401) {
                throw new Error('401 unauthorized — set your API token in Options');
            }
            if (response.status === 403) {
                const text = await response.text();
                throw new Error(`403 forbidden — ${text || 'token lacks required scope'}`);
            }

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`${response.status} ${text}`);
            }

            const data = await response.json();
            setStatus(result, true, data.isUpdate ? `✓ Updated ${data.noteId}` : `✓ Saved as ${data.noteId}`);
            setTimeout(() => window.close(), 1200);
        } catch (err) {
            setStatus(result, false, `Failed: ${err.message ?? err}`);
        } finally {
            button.disabled = false;
        }
    });
};

document.addEventListener('DOMContentLoaded', init);