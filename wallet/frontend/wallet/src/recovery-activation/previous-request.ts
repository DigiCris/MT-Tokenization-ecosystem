// Pedidos de R anteriores del onboarding (N5 de la segunda revisión de P17.MAN, hallazgo 2 de la tercera): cada pedido
// obliga a Recovery a crear otra R, así que el primero después de recargar la pestaña o de volver a montar el paso (tras
// otro step-up) tiene que avisarlo igual que el segundo. Lo sabe esta pestaña, con una marca en su sessionStorage que
// lleva sólo el id de la wallet (nada sensible: ni claves, ni sobres, ni tokens, ni el `k` del pedido), o la plataforma,
// si el último pedido ya tiene una R enviada (`deployment.R`). Sólo para el onboarding: en un reemplazo de R, la R
// anterior es la vigente y sus backups no se destruyen.
import { readTabFlag, writeTabFlag } from '../storage/flags.ts';

const FLAG = 'onboarding.recoveryRequest';

/** Esta pestaña generó un pedido de R para el onboarding de esa wallet. */
export function markOnboardingRequest(walletId: string): void {
  writeTabFlag(FLAG, walletId.toLowerCase());
}

/** ¿Ya hubo un pedido de R para esa wallet? Por la marca de esta pestaña o por la R que informa la plataforma. */
export function hadOnboardingRequest(walletId: string, deployedRecoveryKey: string | null = null): boolean {
  return deployedRecoveryKey !== null || readTabFlag(FLAG) === walletId.toLowerCase();
}
