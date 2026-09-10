import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'astera_tokenization_mock_v1';
const SESSION_KEY = 'astera_tokenization_session_v1';

const now = '2026-09-09T18:00:00.000Z';

export const seedData = {
  version: 1,
  tenants: [
    {
      id: 'tenant-madero',
      name: 'Madero Urban',
      legalName: 'Madero Urban Real Estate S.A.',
      slug: 'madero-urban',
      status: 'active',
      brand: '#2457f5',
      issuerWallet: '0x4D7A...91C2',
      adminEmail: 'admin@madero.demo',
      createdAt: '2026-07-14T10:00:00.000Z',
    },
    {
      id: 'tenant-arena',
      name: 'Arena Desarrollos',
      legalName: 'Arena Desarrollos S.A.',
      slug: 'arena-desarrollos',
      status: 'active',
      brand: '#0f8a72',
      issuerWallet: '0x771F...A119',
      adminEmail: 'admin@arena.demo',
      createdAt: '2026-08-02T11:00:00.000Z',
    },
    {
      id: 'tenant-andes',
      name: 'Andes Habitat',
      legalName: 'Andes Habitat S.A.',
      slug: 'andes-habitat',
      status: 'active',
      brand: '#8b5cf6',
      issuerWallet: '0x02C4...6E88',
      adminEmail: 'admin@andes.demo',
      createdAt: '2026-08-20T15:30:00.000Z',
    },
  ],
  users: [
    {
      id: 'master-1', globalUserId: 'GLOBAL-PSAV-001', tenantId: null, role: 'master_admin',
      name: 'Master Admin', email: 'admin@tokeniza.demo', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xMASTER', balanceUsdc: 0, frozen: false,
    },
    {
      id: 'ta-madero', globalUserId: 'GLOBAL-ADMIN-001', tenantId: 'tenant-madero', role: 'tenant_admin',
      name: 'Lucía Ferraro', email: 'admin@madero.demo', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xMADEROADMIN', balanceUsdc: 0, frozen: false,
    },
    {
      id: 'ta-arena', globalUserId: 'GLOBAL-ADMIN-002', tenantId: 'tenant-arena', role: 'tenant_admin',
      name: 'Mateo Funes', email: 'admin@arena.demo', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xARENAADMIN', balanceUsdc: 0, frozen: false,
    },
    {
      id: 'ta-andes', globalUserId: 'GLOBAL-ADMIN-003', tenantId: 'tenant-andes', role: 'tenant_admin',
      name: 'Sofía Ríos', email: 'admin@andes.demo', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xANDESADMIN', balanceUsdc: 0, frozen: false,
    },
    {
      id: 'inv-cris-madero', globalUserId: 'GLOBAL-INV-1001', tenantId: 'tenant-madero', role: 'investor',
      name: 'Cristian Demo', email: 'inversor@demo.com', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xC91A...44D0', balanceUsdc: 4820, frozen: false,
      savedAddresses: ['0x12AA...901B'],
    },
    {
      id: 'inv-cris-arena', globalUserId: 'GLOBAL-INV-1001', tenantId: 'tenant-arena', role: 'investor',
      name: 'Cristian Demo', email: 'inversor@demo.com', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xC91A...44D0', balanceUsdc: 1950, frozen: false,
      savedAddresses: [],
    },
    {
      id: 'inv-ana-madero', globalUserId: 'GLOBAL-INV-1002', tenantId: 'tenant-madero', role: 'investor',
      name: 'Ana Molina', email: 'ana@demo.com', password: 'demo123',
      kyc: 'approved', aml: 'pending', wallet: '0xA114...B9C0', balanceUsdc: 1200, frozen: false, savedAddresses: [],
    },
    {
      id: 'inv-juan-madero', globalUserId: 'GLOBAL-INV-1003', tenantId: 'tenant-madero', role: 'investor',
      name: 'Juan Pérez', email: 'juan@demo.com', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xB811...09A2', balanceUsdc: 850, frozen: false, savedAddresses: [],
    },
    {
      id: 'inv-lola-arena', globalUserId: 'GLOBAL-INV-1004', tenantId: 'tenant-arena', role: 'investor',
      name: 'Lola Paz', email: 'lola@demo.com', password: 'demo123',
      kyc: 'approved', aml: 'approved', wallet: '0xF2AA...103C', balanceUsdc: 2400, frozen: false, savedAddresses: [],
    },
  ],
  projects: [
    {
      id: 'project-murrd', tenantId: 'tenant-madero', name: 'Madero Urban Residences I',
      tokenName: 'Madero Urban Real Estate I Representación Digital', symbol: 'MURRD',
      status: 'funding', softCap: 350000, hardCap: 500000, raised: 278400, deadline: '2026-11-30',
      apr: 11.5, termMonths: 24, city: 'Puerto Madero, CABA', type: 'Real Estate',
      issuerWallet: '0x4D7A...91C2', escrowBalance: 278400, escrowReleased: false,
      summary: 'Desarrollo residencial premium con unidades de 1 a 3 ambientes y amenities, estructurado mediante representación digital.',
      docs: ['Memorando de inversión', 'Contrato de suscripción', 'Términos de la emisión'],
      createdAt: '2026-08-05T12:00:00.000Z',
    },
    {
      id: 'project-mupk', tenantId: 'tenant-madero', name: 'Madero Park Offices',
      tokenName: 'Madero Park Office Digital Note', symbol: 'MUPK',
      status: 'funded', softCap: 180000, hardCap: 300000, raised: 224800, deadline: '2026-08-31',
      apr: 10.2, termMonths: 18, city: 'Puerto Madero, CABA', type: 'Real Estate',
      issuerWallet: '0x4D7A...91C2', escrowBalance: 0, escrowReleased: true,
      summary: 'Fondeo para adecuación y comercialización de oficinas flexibles con renta objetivo en dólares.',
      docs: ['Memorando de inversión', 'Contrato de suscripción'],
      createdAt: '2026-06-12T12:00:00.000Z',
    },
    {
      id: 'project-arei', tenantId: 'tenant-arena', name: 'Arena Real Estate I',
      tokenName: 'Arena Real Estate I', symbol: 'AREI',
      status: 'funding', softCap: 250000, hardCap: 400000, raised: 161750, deadline: '2026-12-18',
      apr: 12.0, termMonths: 30, city: 'Palermo, CABA', type: 'Real Estate',
      issuerWallet: '0x771F...A119', escrowBalance: 161750, escrowReleased: false,
      summary: 'Proyecto residencial urbano orientado a renta temporal y posterior salida por venta de unidades.',
      docs: ['Memorando de inversión', 'Contrato de suscripción', 'Anexo económico'],
      createdAt: '2026-08-18T12:00:00.000Z',
    },
    {
      id: 'project-arlog', tenantId: 'tenant-arena', name: 'Arena Logística Sur',
      tokenName: 'Arena Logistics Digital Security', symbol: 'ARLOG',
      status: 'draft', softCap: 500000, hardCap: 780000, raised: 0, deadline: '2027-01-31',
      apr: 13.1, termMonths: 36, city: 'Avellaneda, Buenos Aires', type: 'Logística',
      issuerWallet: '0x771F...A119', escrowBalance: 0, escrowReleased: false,
      summary: 'Centro logístico de última milla. Emisión en preparación y todavía no visible para inversores.',
      docs: ['Borrador de términos'],
      createdAt: '2026-09-01T12:00:00.000Z',
    },
    {
      id: 'project-andes', tenantId: 'tenant-andes', name: 'Andes Living Córdoba',
      tokenName: 'Andes Living I', symbol: 'ANDL',
      status: 'funding', softCap: 190000, hardCap: 320000, raised: 80500, deadline: '2027-02-15',
      apr: 10.8, termMonths: 28, city: 'Nueva Córdoba, Córdoba', type: 'Real Estate',
      issuerWallet: '0x02C4...6E88', escrowBalance: 80500, escrowReleased: false,
      summary: 'Desarrollo de unidades compactas para renta, con colocación escalonada por hitos de obra.',
      docs: ['Memorando de inversión', 'Contrato de suscripción'],
      createdAt: '2026-09-02T12:00:00.000Z',
    },
  ],
  subscriptions: [
    { id: 'sub-1', userId: 'inv-cris-madero', projectId: 'project-murrd', status: 'signed', signedAt: '2026-08-19T13:00:00.000Z' },
    { id: 'sub-2', userId: 'inv-cris-madero', projectId: 'project-mupk', status: 'signed', signedAt: '2026-06-20T13:00:00.000Z' },
    { id: 'sub-3', userId: 'inv-cris-arena', projectId: 'project-arei', status: 'signed', signedAt: '2026-08-25T13:00:00.000Z' },
  ],
  investments: [
    { id: 'i1', userId: 'inv-cris-madero', projectId: 'project-murrd', tokens: 2100, invested: 2100, createdAt: '2026-08-19T14:00:00.000Z' },
    { id: 'i2', userId: 'inv-cris-madero', projectId: 'project-mupk', tokens: 1250, invested: 1250, createdAt: '2026-06-20T14:00:00.000Z' },
    { id: 'i3', userId: 'inv-ana-madero', projectId: 'project-murrd', tokens: 800, invested: 800, createdAt: '2026-08-22T14:00:00.000Z' },
    { id: 'i4', userId: 'inv-juan-madero', projectId: 'project-murrd', tokens: 600, invested: 600, createdAt: '2026-08-26T14:00:00.000Z' },
    { id: 'i5', userId: 'inv-cris-arena', projectId: 'project-arei', tokens: 950, invested: 950, createdAt: '2026-08-25T14:00:00.000Z' },
    { id: 'i6', userId: 'inv-lola-arena', projectId: 'project-arei', tokens: 1500, invested: 1500, createdAt: '2026-08-27T14:00:00.000Z' },
  ],
  transactions: [
    { id: 't1', userId: 'inv-cris-madero', tenantId: 'tenant-madero', type: 'deposit_usdc', amount: 6000, currency: 'USDC', status: 'completed', description: 'Ingreso de USDC desde wallet externa', createdAt: '2026-08-18T12:00:00.000Z' },
    { id: 't2', userId: 'inv-cris-madero', tenantId: 'tenant-madero', projectId: 'project-murrd', type: 'investment', amount: -2100, currency: 'USDC', status: 'completed', description: 'Inversión en MURRD', createdAt: '2026-08-19T14:00:00.000Z' },
    { id: 't3', userId: 'inv-cris-madero', tenantId: 'tenant-madero', projectId: 'project-mupk', type: 'interest', amount: 170, currency: 'USDC', status: 'completed', description: 'Pago de intereses MUPK', createdAt: '2026-09-05T16:00:00.000Z' },
    { id: 't4', userId: 'inv-cris-arena', tenantId: 'tenant-arena', type: 'deposit_fiat', amount: 2900, currency: 'USDC', status: 'completed', description: 'Compra de USDC con pesos vía Bitbase', createdAt: '2026-08-24T12:00:00.000Z' },
    { id: 't5', userId: 'inv-cris-arena', tenantId: 'tenant-arena', projectId: 'project-arei', type: 'investment', amount: -950, currency: 'USDC', status: 'completed', description: 'Inversión en AREI', createdAt: '2026-08-25T14:00:00.000Z' },
  ],
  issuanceRequests: [
    {
      id: 'req-1', tenantId: 'tenant-madero', requestedBy: 'ta-madero', status: 'pending',
      projectName: 'Madero Studios II', symbol: 'MSTD', softCap: 220000, hardCap: 360000,
      deadline: '2027-03-30', requestedAt: '2026-09-08T15:00:00.000Z',
    },
  ],
  secondaryOrders: [
    { id: 'o1', tenantId: 'tenant-madero', projectId: 'project-mupk', sellerUserId: 'inv-cris-madero', amount: 250, price: 1.02, remaining: 250, status: 'open', createdAt: '2026-09-07T12:00:00.000Z' },
    { id: 'o2', tenantId: 'tenant-arena', projectId: 'project-arei', sellerUserId: 'inv-lola-arena', amount: 300, price: 1.01, remaining: 300, status: 'open', createdAt: '2026-09-08T12:00:00.000Z' },
  ],
  auditLog: [
    { id: 'a1', actor: 'Master Admin', action: 'Plataforma creada', detail: 'Andes Habitat', createdAt: '2026-08-20T15:30:00.000Z' },
    { id: 'a2', actor: 'Lucía Ferraro', action: 'Solicitud de emisión', detail: 'Madero Studios II · MSTD', createdAt: '2026-09-08T15:00:00.000Z' },
  ],
  createdAt: now,
};

const StoreContext = createContext(null);

function cloneSeed() {
  return JSON.parse(JSON.stringify(seedData));
}

export function StoreProvider({ children }) {
  const [data, setData] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : cloneSeed();
    } catch {
      return cloneSeed();
    }
  });

  const [session, setSessionState] = useState(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try { setData(JSON.parse(event.newValue)); } catch { /* noop */ }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setSession = (value) => {
    setSessionState(value);
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  };

  const mutate = (producer) => {
    setData((current) => {
      const next = JSON.parse(JSON.stringify(current));
      producer(next);
      return next;
    });
  };

  const reset = () => {
    setData(cloneSeed());
    setSession(null);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cloneSeed()));
  };

  const value = useMemo(() => ({ data, session, setSession, mutate, reset }), [data, session]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside StoreProvider');
  return value;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function money(value, currency = 'USDC') {
  const formatted = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(Number(value || 0));
  return currency === 'ARS' ? `$ ${formatted}` : `${formatted} ${currency}`;
}

export function dateFmt(value) {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}
