// A dónde ir después de iniciar sesión: sin wallet o con el onboarding a medias, al onboarding; con la wallet activa, a
// desbloquearla.
import type { SessionStore } from '../session/store.ts';

export async function afterSignIn(store: SessionStore): Promise<string> {
  const wallet = await store.refreshWallet();
  if (wallet === null || wallet.status === 'CREATING') return '/onboarding';
  if (wallet.status === 'ACTIVE' || wallet.status === 'MIGRATING' || wallet.status === 'SOVEREIGN_MODIFIED') {
    return '/unlock';
  }
  return '/';
}
