import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd() + '/../..', '');
    const uiPort = Number.parseInt(env.WEB_PORT ?? '5757', 10);
    const apiPort = Number.parseInt(env.WEB_API_PORT ?? '3001', 10);

    return {
        root: '.',
        server: {
            port: uiPort,
            proxy: {
                '/api': `http://localhost:${apiPort}`
            }
        },
        build: {
            outDir: 'dist/web',
            emptyOutDir: true
        }
    };
});