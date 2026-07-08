const DEFAULT = 'http://localhost:3001';

const init = async () => {
    const {serverUrl, apiToken} = await chrome.storage.sync.get(['serverUrl', 'apiToken']);
    document.getElementById('server-url').value = serverUrl || DEFAULT;
    document.getElementById('api-token').value = apiToken || '';

    document.getElementById('save').addEventListener('click', async () => {
        const url = document.getElementById('server-url').value.trim() || DEFAULT;
        const token = document.getElementById('api-token').value.trim();
        await chrome.storage.sync.set({serverUrl: url, apiToken: token});
        const result = document.getElementById('result');
        const tokenNote = token.length > 0 ? ' · token set' : ' · no token (server must be unauthenticated)';
        result.textContent = `Saved · ${url}${tokenNote}`;
        result.classList.remove('err');
        result.classList.add('ok');
    });
};

document.addEventListener('DOMContentLoaded', init);