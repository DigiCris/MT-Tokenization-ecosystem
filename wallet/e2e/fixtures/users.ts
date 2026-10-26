// Cuentas y wallets armadas por API para los specs que no prueban esos pasos (P22.T01): el mismo camino que la app
// (registro, verificación por el código que llega a Mailpit, OPAQUE, step-up, enrollment de R y deploy de la Safe hasta
// ACTIVE), sin la UI. Los specs que prueban el alta, el onboarding o el enrollment los hacen por las pantallas.
export { ACCOUNT_PASSWORD, uniqueEmail, walletApi, recoveryClient, browserLikeFetch } from './wallet/node-api.ts';
export {
  verifiedAccount,
  activeWallet,
  onboardWallet,
  stepUp,
  submitRecovery,
  passwordWords,
  type Account,
  type ActiveWallet,
} from './wallet/onboard.ts';
