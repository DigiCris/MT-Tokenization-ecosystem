// Rutas de la app Wallet (§8.4). P17: cuenta, onboarding de U, desbloqueo, restauración y seguridad (sesiones, TOTP,
// backups, Password U). La operación (home completo, envíos, swap, whitelist, actividad) llega en P18.
import type { ReactNode } from 'react';
import { createBrowserRouter } from 'react-router';
import { SessionsPage, TotpPage } from '../auth/AccountSecurityPages.tsx';
import { LoginPage } from '../auth/LoginPage.tsx';
import { AccountUnlockPage, ForgotPasswordPage, ResetPasswordPage } from '../auth/PasswordResetPages.tsx';
import { RegisterPage } from '../auth/RegisterPage.tsx';
import { VerifyEmailPage } from '../auth/VerifyEmailPage.tsx';
import { OnboardingPage } from '../onboarding/OnboardingPage.tsx';
import { RestorePage } from '../restore/RestorePage.tsx';
import { ChangePasswordUPage, LostPasswordUPage } from '../security/password-u/PasswordUPages.tsx';
import { SecurityPage } from '../security/SecurityPage.tsx';
import { UnlockPage } from '../unlock/UnlockPage.tsx';
import { AppShell } from './AppShell.tsx';
import { DeviceCheckPage } from './DeviceCheckPage.tsx';
import { HomePage } from './HomePage.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { RequireAccount } from './RequireAccount.tsx';
import { RouteError } from './RouteError.tsx';

const account = (element: ReactNode) => <RequireAccount>{element}</RequireAccount>;

export function createAppRouter() {
  return createBrowserRouter([
    {
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <HomePage /> },
        { path: 'device-check', element: <DeviceCheckPage /> },
        { path: 'register', element: <RegisterPage /> },
        { path: 'verify-email', element: <VerifyEmailPage /> },
        { path: 'login', element: <LoginPage /> },
        { path: 'forgot-password', element: <ForgotPasswordPage /> },
        { path: 'reset-password', element: <ResetPasswordPage /> },
        { path: 'account-unlock', element: <AccountUnlockPage /> },
        { path: 'onboarding', element: account(<OnboardingPage />) },
        { path: 'unlock', element: account(<UnlockPage />) },
        { path: 'restore', element: <RestorePage /> },
        { path: 'security', element: account(<SecurityPage />) },
        { path: 'security/sessions', element: account(<SessionsPage />) },
        { path: 'security/totp', element: account(<TotpPage />) },
        { path: 'security/password-u', element: account(<ChangePasswordUPage />) },
        { path: 'security/lost-password-u', element: account(<LostPasswordUPage />) },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}
