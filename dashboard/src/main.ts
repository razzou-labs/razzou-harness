import { Dialog, Notify, Quasar } from 'quasar';
import iconSet from 'quasar/icon-set/svg-material-icons.js';
import 'quasar/dist/quasar.prod.css';
import { createApp } from 'vue';
import { App } from './App.tsx';
import './styles.css';
import { savedTheme } from './ui.tsx';

// Quasar's prebuilt CSS and SVG icons, its own included: no Sass, no font files, nothing the
// page's policy refuses. Light or dark as the owner last chose in this browser, else as the system is.
createApp(App).use(Quasar, { iconSet, plugins: { Dialog, Notify }, config: { dark: savedTheme() } }).mount('#app');
