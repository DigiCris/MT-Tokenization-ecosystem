/// <reference types="vite/client" />

// Los tests unitarios importan módulos de src con imports de Vite (`?url`, `?worker&url`): vitest los resuelve con el
// pipeline de Vite y estos tipos los describen para tsc.
