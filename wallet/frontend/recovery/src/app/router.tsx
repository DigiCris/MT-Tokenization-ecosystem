// Rutas de la app Recovery (§8.4): inicio, comprobación del dispositivo, cuenta, enrollment desde el link de la Wallet,
// recuperar U, rotaciones, emergencia, migración, restaurar R y modo soberano. /restore y /sovereign usan la cámara
// (Permissions-Policy sólo para esas rutas cargadas como documento: se entra con navegación completa).
import { createBrowserRouter } from 'react-router';
import { LoginPage } from '../auth/LoginPage.tsx';
import { EmergencyPage } from '../emergency/EmergencyPage.tsx';
import { EnrollPage } from '../enroll/EnrollPage.tsx';
import { MigrationPage } from '../migration/MigrationPage.tsx';
import { RecoverUPage } from '../recover-u/RecoverUPage.tsx';
import { RestorePage } from '../restore/RestorePage.tsx';
import { RotationsPage } from '../rotations/RotationsPage.tsx';
import { SovereignPage } from '../sovereign/SovereignPage.tsx';
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
        { path: 'login', element: <LoginPage /> },
        { path: 'enroll', element: <EnrollPage /> },
        { path: 'recover-u', element: <RecoverUPage /> },
        { path: 'rotations', element: <RotationsPage /> },
        { path: 'emergency', element: <EmergencyPage /> },
        { path: 'migration', element: <MigrationPage /> },
        { path: 'restore', element: <RestorePage /> },
        { path: 'sovereign', element: <SovereignPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}
