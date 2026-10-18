// Rutas de la app Wallet (§8.4). P17: cuenta, onboarding de U, desbloqueo, restauración y seguridad (sesiones, TOTP,
// backups, Password U). P18: activación de Recovery y Safe, inicio operativo, activos, envíos, swap, whitelist,
// actividad, rotaciones, reemplazo de Recovery, co-firma soberana y migración excepcional.
import type { ReactNode } from 'react';
import { ActivityPage } from '../activity/ActivityPage.tsx';
import { AssetsPage } from '../assets/AssetsPage.tsx';
import { MigrationPage } from '../migration/MigrationPage.tsx';
import { ReplaceRecoveryPage } from '../security/recovery/ReplaceRecoveryPage.tsx';
import { RotationsPage } from '../security/rotations/RotationsPage.tsx';
import { SendPage } from '../send/SendPage.tsx';
import { SovereignPage } from '../sovereign/SovereignPage.tsx';
import { SwapPage } from '../swap/SwapPage.tsx';
import { WhitelistPage } from '../whitelist/WhitelistPage.tsx';
import { createBrowserRouter } from 'react-router';
import { SessionsPage, TotpPage } from '../auth/AccountSecurityPages.tsx';
import { LoginPage } from '../auth/LoginPage.tsx';
import { AccountUnlockPage, ForgotPasswordPage, ResetPasswordPage } from '../auth/PasswordResetPages.tsx';
import { RegisterPage } from '../auth/RegisterPage.tsx';
import { VerifyEmailPage } from '../auth/VerifyEmailPage.tsx';
import { OnboardingPage } from '../onboarding/OnboardingPage.tsx';
import { ConfirmRecoveryPage } from '../recovery-activation/ConfirmRecoveryPage.tsx';
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
        { path: 'onboarding/confirm-recovery', element: account(<ConfirmRecoveryPage />) },
        { path: 'unlock', element: account(<UnlockPage />) },
        { path: 'restore', element: <RestorePage /> },
        { path: 'security', element: account(<SecurityPage />) },
        { path: 'security/sessions', element: account(<SessionsPage />) },
        { path: 'security/totp', element: account(<TotpPage />) },
        { path: 'security/password-u', element: account(<ChangePasswordUPage />) },
        { path: 'security/lost-password-u', element: account(<LostPasswordUPage />) },
        { path: 'security/rotations', element: account(<RotationsPage />) },
        { path: 'security/recovery', element: account(<ReplaceRecoveryPage />) },
        { path: 'security/migration', element: account(<MigrationPage />) },
        { path: 'assets', element: account(<AssetsPage />) },
        { path: 'send', element: account(<SendPage />) },
        { path: 'swap', element: account(<SwapPage />) },
        { path: 'whitelist', element: account(<WhitelistPage />) },
        { path: 'activity', element: account(<ActivityPage />) },
        // Sin cuenta: la salida soberana tiene que funcionar aunque la plataforma no esté.
        { path: 'sovereign', element: <SovereignPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}
