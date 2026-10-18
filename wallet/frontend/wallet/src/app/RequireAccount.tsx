// Rutas que necesitan la sesión de cuenta: sin ella, al login (y de vuelta después).
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSession } from '../session/context.tsx';

export function RequireAccount({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'loading') return <p role="status">Cargando…</p>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ returnTo: location.pathname }} />;
  return children;
}
