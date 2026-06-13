import './Styles.css';
import 'highlight.js/styles/github-dark.css';
import {App} from './App.js';

const host = document.getElementById('root');

if (host === null) {
    throw new Error('Root element not found');
}

const app = new App();
void app.mount(host);