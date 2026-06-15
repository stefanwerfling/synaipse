const DEFAULT = 'http://localhost:3001';

const init = async () => {
    const {serverUrl} = await chrome.storage.sync.get(['serverUrl']);
    document.getElementById('server-url').value = serverUrl || DEFAULT;

    document.getElementById('save').addEventListener('click', async () => {
        const url = document.getElementById('server-url').value.trim() || DEFAULT;
        await chrome.storage.sync.set({serverUrl: url});
        const result = document.getElementById('result');
        result.textContent = `Saved · ${url}`;
        result.classList.add('ok');
    });
};

document.addEventListener('DOMContentLoaded', init);