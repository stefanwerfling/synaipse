import {mount} from './mount.js';

/** Standalone boot: the same mount() an embedding host uses, plus the login gate. */
const host = document.getElementById('root');

if (host === null) {
    throw new Error('Root element not found');
}

void mount(host, {authGate: true, routing: 'hash'});
