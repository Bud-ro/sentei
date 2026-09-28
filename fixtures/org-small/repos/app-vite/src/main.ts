import { mountApp } from './mount';

// Every page module is loaded by the glob (no import names them).
const pages = import.meta.glob('./pages/*.ts');
mountApp(Object.keys(pages));
