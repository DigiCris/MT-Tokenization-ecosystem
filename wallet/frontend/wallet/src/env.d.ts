/// <reference types="vite/client" />

// Módulos virtuales del build (build/app-config.ts y build/system-contracts.ts).
declare module 'virtual:mtw-config' {
  const config: Readonly<{
    app: 'wallet';
    environment: 'local' | 'ci' | 'staging' | 'production';
    apiBaseUrl: string;
    rpcUrl: string;
    recoveryOrigin: string;
    googleClientId: string | null;
    googleRedirectUri: string;
    releaseId: string;
    gitCommit: string;
    sourceDateEpoch: number;
  }>;
  export default config;
}

declare module 'virtual:mtw-system-contracts' {
  const file: unknown;
  export default file;
}
