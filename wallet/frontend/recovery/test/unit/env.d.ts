/// <reference types="vite/client" />

// Los tests unitarios y los helpers de Playwright importan módulos de src con imports de Vite (`?url`, `?raw`): vitest
// los resuelve con el pipeline de Vite y estos tipos los describen para tsc.
