import './Styles.css';
import {App} from './App.js';
import {initTheme} from './Theme.js';

initTheme();

const host = document.getElementById('root');

if (host === null) {
    throw new Error('Root element not found');
}

const app = new App();
void app.mount(host);