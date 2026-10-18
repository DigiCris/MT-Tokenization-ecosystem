// Kill-switch de service workers ([F-SEC-04], P16.T04): la app no publica ningún service worker y el servidor estático
// responde 403 a los pedidos de scripts de SW; si igual hay uno registrado para este origin (de un deploy anterior o de
// un ataque), al arrancar se desregistra y se reporta.
export async function removeServiceWorkers(
  container: Pick<ServiceWorkerContainer, 'getRegistrations'> | undefined,
  report: (scope: string) => void,
): Promise<number> {
  if (container === undefined) return 0;
  const registrations = await container.getRegistrations();
  for (const registration of registrations) {
    await registration.unregister();
    report(registration.scope);
  }
  return registrations.length;
}
