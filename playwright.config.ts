import {defineConfig, devices} from '@playwright/test';

/**
 * Browser smoke (plan G3/P4): the built UI against an isolated server with
 * the fixture vault (e2e/serve.mjs). Needs `npm run build` first.
 * Locally E2E_CHANNEL=chrome uses an installed Chrome instead of the
 * Playwright download; CI installs Chromium.
 */
const port = Number(process.env.E2E_PORT ?? 4177);
const channel = process.env.E2E_CHANNEL;

export default defineConfig({
    testDir: 'e2e',
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        trace: 'retain-on-failure',
        ...devices['Desktop Chrome'],
        ...(channel !== undefined && channel !== '' ? {channel} : {})
    },
    webServer: {
        command: 'node e2e/serve.mjs',
        url: `http://127.0.0.1:${port}/api/info`,
        env: {E2E_PORT: String(port)},
        reuseExistingServer: !process.env.CI,
        timeout: 60_000
    }
});
