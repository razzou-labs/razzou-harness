import { Dialog, Notify, Quasar } from 'quasar';
import 'quasar/dist/quasar.prod.css';
import { createApp } from 'vue';
import { App } from './App.tsx';
import './styles.css';

// Quasar's prebuilt CSS and SVG icons: no Sass, no font files, nothing the page's policy refuses.
createApp(App).use(Quasar, { plugins: { Dialog, Notify }, config: { dark: 'auto' } }).mount('#app');
