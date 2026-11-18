import {defineConfig} from 'vite';

/**
 * Library build of the embed frontend (plan P9 / E4): `mount()` as ESM in
 * dist/lib with one CSS file. Everything is bundled (workspace packages
 * and npm dependencies), so a host consumes one consistent artifact and
 * needs none of Synaipse's dependencies itself. Lazy panels and heavy
 * libraries (jsNGraph, infographic, mdfloor) stay separate chunks that the
 * host's bundler loads on demand.
 *
 *   import {mount} from '@synaipse/web/mount';
 *   import '@synaipse/web/mount.css';
 */
export default defineConfig({
    root: '.',
    publicDir: false,
    // Lib mode leaves process.env to the consumer; in a browser `process`
    // does not exist. Bundled libraries (3d-force-graph, postcss inside
    // @antv/infographic) read it, so fix the values here.
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env.LANG': 'undefined'
    },
    build: {
        outDir: 'dist/lib',
        emptyOutDir: true,
        sourcemap: true,
        target: 'es2022',
        cssCodeSplit: false,
        lib: {
            entry: 'src/mount.ts',
            formats: ['es'],
            fileName: () => 'mount.js',
            cssFileName: 'synaipse'
        },
        rollupOptions: {
            output: {
                chunkFileNames: 'chunks/[name]-[hash].js',
                // The one stylesheet keeps a fixed name for the package export.
                assetFileNames: (asset) => (asset.names.some((n) => n.endsWith('.css')) ? 'synaipse.css' : 'assets/[name]-[hash][extname]')
            }
        }
    }
});
