// Rutas de la app Recovery (§8.4). P16 deja el shell, el inicio y la comprobación del dispositivo; las pantallas de
// cuenta, enrollment, recuperación, rotaciones, modo soberano, emergencia y migración se agregan en P19.
import { createBrowserRouter } from 'react-router';
import { AppShell } from './AppShell.tsx';
import { DeviceCheckPage } from './DeviceCheckPage.tsx';
import { HomePage } from './HomePage.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { RouteError } from './RouteError.tsx';

export function createAppRouter() {
  return createBrowserRouter([
    {
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <HomePage /> },
        { path: 'device-check', element: <DeviceCheckPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}
