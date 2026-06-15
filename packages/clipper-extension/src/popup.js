// MV3 popup script. Pulls the current tab, hands optional selection extraction
// off to a content script via chrome.scripting.executeScript, then POSTs HTML
// (or selection) to the Synaipse server on the configured host.

const DEFAULT_SERVER = 'http://localhost:3001';

const $ = (id) => document.getElementById(id);

const loadServer = async () => {
    const stored = await chrome.storage.sync.get(['serverUrl']);
    return stored.serverUrl || DEFAULT_SERVER;
};

const checkServer = async (serverUrl) => {
    try {
        const response = await fetch(`${serverUrl}/api/info`, {method: 'GET'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return true;
    } catch {
        return false;
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

const init = async () => {
    const serverUrl = await loadServer();
    const tab = await getActiveTab();

    if (tab !== undefined) {
        $('title').value = tab.title ?? '';
    }

    const ok = await checkServer(serverUrl);
    setStatus($('server-status'), ok, ok ? `connected · ${serverUrl}` : `no server at ${serverUrl}`);

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
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });

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