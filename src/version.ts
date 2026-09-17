import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Resolves from both src/ (tsx) and dist/ (node) because both sit one level below the package root.
const pkg = require('../package.json') as { name: string; version: string };

export const APP_NAME: string = pkg.name;
export const APP_VERSION: string = pkg.version;
