// Wallet externa de prueba (P22.T01, «R externa» de P22.T02.g): un provider EIP-1193 anunciado por EIP-6963 antes de
// los scripts de la página, como lo inyecta una extensión, que firma en Node con una clave de prueba y transmite por el
// Anvil del stack. La app Recovery no sabe que no es una extensión real.
export { installTestWallet, type TestWalletOptions } from './recovery/test-wallet.ts';
