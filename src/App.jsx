import React, { useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Banknote, BarChart3, Bell, Building2, Check,
  ChevronRight, CircleDollarSign, ClipboardCheck, Coins, FileCheck2, FileSignature,
  Fingerprint, HandCoins, Landmark, LayoutDashboard,
  Menu, Plus, ReceiptText, RefreshCcw, Search, Settings, ShieldCheck, ShoppingCart,
  Sparkles, Store, TrendingUp, Users, WalletCards, X, AlertTriangle,
  Eye, Send, CircleCheck, Clock3, ShieldAlert,
  FileText, Network, ArrowUpRight, ArrowDownLeft, Undo2, Scale, BriefcaseBusiness,
  Globe2, Layers3, Info, KeyRound, ScrollText
} from 'lucide-react';
import { StoreProvider, useStore, uid, money, dateFmt } from './store.jsx';

const statusLabels = {
  active: 'Activa', funding: 'En colocación', funded: 'Fondeado', draft: 'Borrador',
  finalized: 'Finalizado', failed: 'No alcanzó soft cap', pending: 'Pendiente', approved: 'Aprobado',
  rejected: 'Rechazado', completed: 'Completado', signed: 'Firmado', open: 'Abierta'
};

const statusTone = {
  active: 'success', funding: 'info', funded: 'success', draft: 'neutral', finalized: 'neutral',
  failed: 'danger', pending: 'warning', approved: 'success', rejected: 'danger', completed: 'success',
  signed: 'success', open: 'info'
};

function App() {
  const onExit = () => {
    window.location.href = '/';
  };
  return (
    <StoreProvider>
      <Platform onExit={onExit} />
    </StoreProvider>
  );
}

function Brand({ dark = false, compact = false }) {
  return <div className={`brand ${dark ? 'dark' : ''} ${compact ? 'compact' : ''}`}><div className="brand-mark">A</div>{!compact && <div><b>ASTERA</b><span>TOKENIZATION</span></div>}</div>;
}

function Platform({ onExit }) {
  const { data, session, setSession } = useStore();
  const user = session ? data.users.find((u) => u.id === session.userId) : null;
  if (!session || !user) return <Login onExit={onExit} />;
  if (user.role === 'master_admin') return <MasterApp user={user} onExit={onExit} />;
  if (user.role === 'tenant_admin') return <TenantApp user={user} onExit={onExit} />;
  return <InvestorApp user={user} onExit={onExit} />;
}

function Login({ onExit }) {
  const { data, setSession, mutate, reset } = useStore();
  const [role, setRole] = useState('investor');
  const [tenantId, setTenantId] = useState('tenant-madero');
  const [email, setEmail] = useState('inversor@demo.com');
  const [password, setPassword] = useState('demo123');
  const [error, setError] = useState('');
  const [register, setRegister] = useState(false);
  const [reg, setReg] = useState({ name: '', email: '', password: 'demo123', tenantId: 'tenant-madero' });

  const presetRole = (next) => {
    setRole(next); setError('');
    if (next === 'master_admin') { setEmail('admin@tokeniza.demo'); setPassword('demo123'); }
    if (next === 'tenant_admin') { setTenantId('tenant-madero'); setEmail('admin@madero.demo'); setPassword('demo123'); }
    if (next === 'investor') { setTenantId('tenant-madero'); setEmail('inversor@demo.com'); setPassword('demo123'); }
  };

  const chooseTenant = (id) => {
    setTenantId(id);
    if (role === 'tenant_admin') {
      const t = data.tenants.find((x) => x.id === id);
      setEmail(t?.adminEmail || '');
    }
  };

  const login = (e) => {
    e.preventDefault();
    let found = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.role === role);
    if (found && role !== 'master_admin' && found.tenantId !== tenantId) {
      found = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password && u.role === role && u.tenantId === tenantId);
    }
    if (!found) return setError('No encontramos esa combinación. Podés usar las credenciales demo que aparecen debajo.');
    setSession({ userId: found.id, loggedAt: Date.now() });
  };

  const registerInvestor = (e) => {
    e.preventDefault();
    if (!reg.name || !reg.email || !reg.password || !reg.tenantId) return;
    let createdId;
    mutate((d) => {
      const existingIdentity = d.users.find((u) => u.email.toLowerCase() === reg.email.toLowerCase() && u.globalUserId);
      const existingTenant = d.users.find((u) => u.email.toLowerCase() === reg.email.toLowerCase() && u.tenantId === reg.tenantId && u.role === 'investor');
      if (existingTenant) { createdId = existingTenant.id; return; }
      createdId = uid('inv');
      d.users.push({
        id: createdId, globalUserId: existingIdentity?.globalUserId || `GLOBAL-INV-${Math.floor(1000 + Math.random()*9000)}`,
        tenantId: reg.tenantId, role: 'investor', name: reg.name, email: reg.email, password: reg.password,
        kyc: existingIdentity?.kyc || 'pending', aml: existingIdentity?.aml || 'pending', wallet: `0x${Math.random().toString(16).slice(2, 6).toUpperCase()}...${Math.random().toString(16).slice(2, 6).toUpperCase()}`,
        balanceUsdc: 0, frozen: false, savedAddresses: []
      });
      d.auditLog.unshift({ id: uid('a'), actor: reg.name, action: 'Registro de inversor', detail: d.tenants.find(t => t.id === reg.tenantId)?.name || '', createdAt: new Date().toISOString() });
    });
    setTimeout(() => setSession({ userId: createdId, loggedAt: Date.now() }), 0);
  };

  return (
    <div className="login-page">
      <div className="login-branding">
        <button className="icon-btn login-back" onClick={onExit}><ArrowLeft/></button>
        <Brand dark />
        <div className="login-message"><span className="eyebrow"><Sparkles size={15}/> Demo multi rol</span><h1>Una plataforma.<br/>Tres puntos de vista.</h1><p>Probá la operación desde el inversor, la constructora y el administrador central. Los datos viven en tu navegador y se sincronizan entre pestañas.</p></div>
        <div className="login-roles-visual"><div><ShieldCheck/><span>Master Admin</span></div><div><Building2/><span>Constructora</span></div><div><Users/><span>Inversor</span></div></div>
      </div>
      <div className="login-panel">
        {!register ? <>
          <div className="login-card">
            <div className="login-title"><h2>Ingresar a la demo</h2><p>Elegí el rol que querés explorar.</p></div>
            <div className="role-tabs">
              <button className={role === 'investor' ? 'active' : ''} onClick={() => presetRole('investor')}><Users/>Inversor</button>
              <button className={role === 'tenant_admin' ? 'active' : ''} onClick={() => presetRole('tenant_admin')}><Building2/>Constructora</button>
              <button className={role === 'master_admin' ? 'active' : ''} onClick={() => presetRole('master_admin')}><ShieldCheck/>Master</button>
            </div>
            {role !== 'master_admin' && <div className="field"><label>Plataforma</label><select value={tenantId} onChange={(e) => chooseTenant(e.target.value)}>{data.tenants.filter(t => t.status === 'active').map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>}
            <form onSubmit={login}>
              <div className="field"><label>Email</label><input value={email} onChange={(e)=>setEmail(e.target.value)} /></div>
              <div className="field"><label>Contraseña</label><input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} /></div>
              {error && <div className="form-error"><AlertTriangle size={16}/>{error}</div>}
              <button className="btn btn-primary btn-block" type="submit">Ingresar <ArrowRight size={16}/></button>
            </form>
            {role === 'investor' && <button className="text-button" onClick={() => setRegister(true)}>Crear una cuenta de inversor</button>}
          </div>
          <div className="demo-hint"><b>Credenciales demo</b><span>Contraseña para todos: <code>demo123</code></span><span>{role === 'master_admin' ? 'admin@tokeniza.demo' : role === 'tenant_admin' ? data.tenants.find(t=>t.id===tenantId)?.adminEmail : 'inversor@demo.com'}</span></div>
          <button className="reset-link" onClick={() => { if(confirm('¿Restablecer todos los datos de la demo?')) reset(); }}><RefreshCcw size={14}/> Restablecer demo</button>
        </> : <div className="login-card">
          <button className="text-button left" onClick={() => setRegister(false)}><ArrowLeft size={15}/> Volver</button>
          <div className="login-title"><h2>Crear cuenta</h2><p>Simulá el registro de un nuevo inversor.</p></div>
          <form onSubmit={registerInvestor}>
            <div className="field"><label>Plataforma</label><select value={reg.tenantId} onChange={(e)=>setReg({...reg,tenantId:e.target.value})}>{data.tenants.filter(t=>t.status==='active').map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            <div className="field"><label>Nombre y apellido</label><input required value={reg.name} onChange={(e)=>setReg({...reg,name:e.target.value})} placeholder="Ej. Valentina Díaz" /></div>
            <div className="field"><label>Email</label><input required type="email" value={reg.email} onChange={(e)=>setReg({...reg,email:e.target.value})} placeholder="valentina@email.com" /></div>
            <div className="field"><label>Contraseña</label><input required type="password" value={reg.password} onChange={(e)=>setReg({...reg,password:e.target.value})} /></div>
            <div className="info-box"><Info size={17}/><span>La cuenta se crea con KYC pendiente. Podrás completar el flujo simulado desde el portal.</span></div>
            <button className="btn btn-primary btn-block" type="submit">Crear cuenta <ArrowRight size={16}/></button>
          </form>
        </div>}
      </div>
    </div>
  );
}

function AppFrame({ user, title, subtitle, nav, active, setActive, children, onExit, tenant, actions }) {
  const { setSession } = useStore();
  const [mobile, setMobile] = useState(false);
  return <div className="app-shell">
    <aside className={`sidebar ${mobile ? 'open' : ''}`}>
      <div className="sidebar-top"><Brand compact/><button className="icon-btn sidebar-close" onClick={()=>setMobile(false)}><X/></button></div>
      {tenant ? <div className="tenant-switch"><span style={{background:tenant.brand}}>{tenant.name.slice(0,1)}</span><div><b>{tenant.name}</b><small>{user.role === 'tenant_admin' ? 'Backoffice' : 'Plataforma de inversión'}</small></div></div> : <div className="tenant-switch master"><span><ShieldCheck/></span><div><b>Control central</b><small>Master Backoffice</small></div></div>}
      <nav className="side-nav">{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={active===item.id?'active':''} onClick={()=>{setActive(item.id);setMobile(false)}}><Icon size={18}/><span>{item.label}</span>{item.badge ? <em>{item.badge}</em>:null}</button>})}</nav>
      <div className="sidebar-bottom">
        <button onClick={()=>setSession(null)}><RefreshCcw size={17}/><span>Cambiar rol demo</span></button>
        <button onClick={onExit}><ArrowLeft size={17}/><span>Volver a la landing</span></button>
      </div>
    </aside>
    <main className="app-main">
      <header className="app-header">
        <button className="icon-btn menu-btn" onClick={()=>setMobile(true)}><Menu/></button>
        <div className="page-title"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
        <div className="header-actions">{actions}<button className="notification"><Bell size={19}/><i/></button><div className="user-chip"><span>{user.name.split(' ').map(x=>x[0]).slice(0,2).join('')}</span><div><b>{user.name}</b><small>{user.email}</small></div></div></div>
      </header>
      <div className="page-content">{children}</div>
    </main>
  </div>
}

function Card({ children, className='' }) { return <div className={`card ${className}`}>{children}</div>; }
function Badge({ status, children }) { return <span className={`badge ${statusTone[status] || 'neutral'}`}>{children || statusLabels[status] || status}</span>; }
function Progress({ value, max, compact=false }) { const pct = Math.max(0, Math.min(100, max ? (value/max)*100 : 0)); return <div className={`progress ${compact?'compact':''}`}><i style={{width:`${pct}%`}}/></div>; }
function Stat({ icon:Icon, label, value, note, tone='' }) { return <Card className={`stat-card ${tone}`}><div className="stat-icon"><Icon size={20}/></div><div><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></Card>; }
function Empty({ icon: Icon=FileText, title, text, action }) { return <div className="empty"><div><Icon/></div><b>{title}</b><p>{text}</p>{action}</div>; }
function Modal({ title, subtitle, onClose, children, wide=false }) { return <div className="modal-backdrop" onMouseDown={(e)=>e.target===e.currentTarget&&onClose()}><div className={`modal ${wide?'wide':''}`}><div className="modal-head"><div><h3>{title}</h3>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-btn" onClick={onClose}><X/></button></div>{children}</div></div>; }
function Toast({ message, onDone }) { React.useEffect(()=>{const t=setTimeout(onDone,2600);return()=>clearTimeout(t)},[onDone]); return <div className="toast"><CircleCheck size={19}/>{message}</div>; }

function InvestorApp({ user, onExit }) {
  const { data, mutate } = useStore();
  const tenant = data.tenants.find(t => t.id === user.tenantId);
  const [active, setActive] = useState('home');
  const [selectedProject, setSelectedProject] = useState(null);
  const [toast, setToast] = useState('');
  const nav = [
    { id:'home', label:'Inicio', icon:LayoutDashboard },
    { id:'projects', label:'Proyectos', icon:Building2 },
    { id:'holdings', label:'Tenencias', icon:WalletCards },
    { id:'movements', label:'Movimientos', icon:ReceiptText },
    { id:'funds', label:'Fondos', icon:CircleDollarSign },
    { id:'secondary', label:'Mercado secundario', icon:Store },
  ];
  const projects = data.projects.filter(p => p.tenantId === user.tenantId && p.status !== 'draft');
  const investments = data.investments.filter(i => i.userId === user.id && i.tokens > 0);
  const totalInvested = investments.reduce((s,i)=>s+i.invested,0);
  const txs = data.transactions.filter(t => t.userId === user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const titleMap = {home:'Hola, '+user.name.split(' ')[0],projects:'Proyectos',holdings:'Tus tenencias',movements:'Movimientos',funds:'Fondos',secondary:'Mercado secundario'};
  const subMap = {home:'Este es el resumen de tu cuenta.',projects:'Explorá oportunidades disponibles en esta plataforma.',holdings:'Todas tus posiciones activas en un solo lugar.',movements:'Historial de ingresos, inversiones, distribuciones y retiros.',funds:'Ingresá o retirá saldo de tu cuenta.',secondary:'Comprá o publicá tokens de otros inversores.'};
  return <>
    <AppFrame user={user} tenant={tenant} title={titleMap[active]} subtitle={subMap[active]} nav={nav} active={active} setActive={(id)=>{setSelectedProject(null);setActive(id)}} onExit={onExit}
      actions={<div className="balance-pill"><WalletCards size={17}/><span>{money(user.balanceUsdc)}</span></div>}>
      {selectedProject ? <InvestorProjectDetail project={selectedProject} user={user} onBack={()=>setSelectedProject(null)} onToast={setToast}/> : <>
        {active==='home' && <InvestorHome user={user} tenant={tenant} projects={projects} investments={investments} txs={txs} totalInvested={totalInvested} onProject={setSelectedProject} setActive={setActive} mutate={mutate}/>} 
        {active==='projects' && <InvestorProjects projects={projects} onProject={setSelectedProject}/>} 
        {active==='holdings' && <Holdings user={user} investments={investments} data={data} onProject={setSelectedProject}/>} 
        {active==='movements' && <Movements txs={txs} data={data}/>} 
        {active==='funds' && <Funds user={user} onToast={setToast}/>} 
        {active==='secondary' && <Secondary user={user} onToast={setToast}/>} 
      </>}
    </AppFrame>
    {toast && <Toast message={toast} onDone={()=>setToast('')}/>} 
  </>;
}

function InvestorHome({ user, tenant, projects, investments, txs, totalInvested, onProject, setActive, mutate }) {
  const needsKyc = user.kyc !== 'approved';
  const earnings = txs.filter(t=>t.type==='interest').reduce((s,t)=>s+Math.max(0,t.amount),0);
  const activeProjects = investments.length;
  const featured = projects.find(p=>p.status==='funding') || projects[0];
  const completeKyc = () => mutate(d => {
    d.users.filter(x=>x.globalUserId===user.globalUserId).forEach(u=>u.kyc='approved');
    d.auditLog.unshift({id:uid('a'),actor:user.name,action:'KYC simulado aprobado',detail:tenant.name,createdAt:new Date().toISOString()});
  });
  return <div className="stack-xl">
    {needsKyc && <div className="action-banner"><div className="action-banner-icon"><Fingerprint/></div><div><b>Completá tu verificación para invertir</b><p>El KYC es el primer paso para habilitar tu wallet y acceder a los proyectos.</p></div><button className="btn btn-primary" onClick={completeKyc}>Simular KYC <ArrowRight size={16}/></button></div>}
    <div className="stats-grid four">
      <Stat icon={WalletCards} label="Saldo disponible" value={money(user.balanceUsdc)} note="Listo para invertir"/>
      <Stat icon={BriefcaseBusiness} label="Capital invertido" value={money(totalInvested)} note={`${activeProjects} posiciones activas`}/>
      <Stat icon={HandCoins} label="Rendimientos recibidos" value={money(earnings)} note="Intereses acreditados"/>
      <Stat icon={ShieldCheck} label="Estado de cuenta" value={user.kyc==='approved'?'Verificada':'Pendiente'} note={`AML ${user.aml==='approved'?'aprobado':'pendiente'}`} tone={user.kyc==='approved'?'success':''}/>
    </div>
    <div className="split-main">
      <div className="stack-lg">
        <div className="panel-heading"><div><h2>Oportunidad destacada</h2><p>Proyecto disponible en {tenant.name}</p></div><button className="text-button" onClick={()=>setActive('projects')}>Ver todos <ArrowRight size={15}/></button></div>
        {featured && <ProjectCard project={featured} onClick={()=>onProject(featured)} featured/>}
      </div>
      <Card className="quick-card">
        <div className="panel-heading"><div><h2>Acciones rápidas</h2><p>Lo más usado en tu cuenta</p></div></div>
        <button onClick={()=>setActive('funds')}><span className="quick-icon"><ArrowDownLeft/></span><div><b>Ingresar fondos</b><small>USDC o compra con pesos</small></div><ChevronRight/></button>
        <button onClick={()=>setActive('projects')}><span className="quick-icon"><Search/></span><div><b>Explorar proyectos</b><small>Ver oportunidades activas</small></div><ChevronRight/></button>
        <button onClick={()=>setActive('holdings')}><span className="quick-icon"><BarChart3/></span><div><b>Ver tenencias</b><small>Tu portfolio tokenizado</small></div><ChevronRight/></button>
      </Card>
    </div>
    <Card>
      <div className="panel-heading"><div><h2>Últimos movimientos</h2><p>Actividad reciente de tu cuenta</p></div><button className="text-button" onClick={()=>setActive('movements')}>Ver historial <ArrowRight size={15}/></button></div>
      <TransactionList txs={txs.slice(0,5)} />
    </Card>
  </div>;
}

function InvestorProjects({ projects, onProject }) {
  const [q,setQ]=useState('');
  const visible=projects.filter(p=>`${p.name} ${p.symbol} ${p.city}`.toLowerCase().includes(q.toLowerCase()));
  return <div className="stack-lg">
    <div className="toolbar"><div className="search-box"><Search size={17}/><input placeholder="Buscar por proyecto, token o ubicación" value={q} onChange={e=>setQ(e.target.value)}/></div><select><option>Todos los estados</option><option>En colocación</option><option>Fondeados</option></select></div>
    <div className="project-grid">{visible.map(p=><ProjectCard key={p.id} project={p} onClick={()=>onProject(p)}/>)}</div>
  </div>;
}

function ProjectCard({ project, onClick, featured=false }) {
  const pct=(project.raised/project.hardCap)*100;
  return <Card className={`project-card ${featured?'featured':''}`}>
    <div className="project-art"><div className="building-shape"><span/><span/><span/></div><Badge status={project.status}/><div className="token-chip">{project.symbol}</div></div>
    <div className="project-card-body">
      <div className="project-title"><div><small>{project.city}</small><h3>{project.name}</h3></div><button className="icon-btn" onClick={onClick}><ArrowUpRight/></button></div>
      <p>{project.summary}</p>
      <div className="project-metrics"><span><small>Retorno objetivo</small><b>{project.apr}% anual</b></span><span><small>Plazo</small><b>{project.termMonths} meses</b></span><span><small>Colocado</small><b>{Math.round(pct)}%</b></span></div>
      <Progress value={project.raised} max={project.hardCap}/>
      <div className="project-progress-label"><span>{money(project.raised)}</span><span>Hard cap {money(project.hardCap)}</span></div>
      <button className="btn btn-secondary btn-block" onClick={onClick}>Ver proyecto <ArrowRight size={16}/></button>
    </div>
  </Card>;
}

function InvestorProjectDetail({ project, user, onBack, onToast }) {
  const { data, mutate } = useStore();
  const liveProject=data.projects.find(p=>p.id===project.id) || project;
  const sub=data.subscriptions.find(s=>s.userId===user.id&&s.projectId===project.id&&s.status==='signed');
  const inv=data.investments.filter(i=>i.userId===user.id&&i.projectId===project.id).reduce((s,i)=>s+i.tokens,0);
  const [signModal,setSignModal]=useState(false);
  const [investModal,setInvestModal]=useState(false);
  const [otp,setOtp]=useState('123456');
  const [consent,setConsent]=useState(false);
  const [amount,setAmount]=useState('500');
  const sign = () => {
    if(otp!=='123456'||!consent) return;
    mutate(d=>d.subscriptions.push({id:uid('sub'),userId:user.id,projectId:project.id,status:'signed',signedAt:new Date().toISOString()}));
    setSignModal(false);onToast('Suscripción firmada. Tu wallet quedó habilitada para este proyecto.');
  };
  const invest=()=>{
    const n=Number(amount);
    if(!n||n<=0) return;
    const currentUser=data.users.find(u=>u.id===user.id);
    if(currentUser.kyc!=='approved') return onToast('Primero debés completar el KYC.');
    if(currentUser.frozen) return onToast('La cuenta está congelada para operar.');
    if(!sub) return onToast('Primero debés firmar la suscripción del proyecto.');
    if(n>currentUser.balanceUsdc) return onToast('Saldo USDC insuficiente.');
    const globalAccountIds=new Set(data.users.filter(u=>u.globalUserId===currentUser.globalUserId).map(u=>u.id));
    const netPosition=data.investments.filter(i=>globalAccountIds.has(i.userId)).reduce((s,i)=>s+i.tokens,0)+n;
    if(netPosition>1500 && currentUser.aml!=='approved') return onToast('Esta operación requiere AML aprobado por superar el umbral configurado.');
    if(liveProject.raised+n>liveProject.hardCap) return onToast('El monto supera el saldo disponible hasta el hard cap.');
    mutate(d=>{
      const u=d.users.find(x=>x.id===user.id);u.balanceUsdc-=n;
      const p=d.projects.find(x=>x.id===project.id);p.raised+=n;p.escrowBalance+=n;
      d.investments.push({id:uid('i'),userId:user.id,projectId:project.id,tokens:n,invested:n,createdAt:new Date().toISOString()});
      d.transactions.unshift({id:uid('t'),userId:user.id,tenantId:user.tenantId,projectId:project.id,type:'investment',amount:-n,currency:'USDC',status:'completed',description:`Inversión en ${project.symbol}`,createdAt:new Date().toISOString()});
      d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Inversión primaria',detail:`${project.symbol} · ${n} USDC`,createdAt:new Date().toISOString()});
    });
    setInvestModal(false);onToast(`Inversión de ${money(n)} simulada correctamente.`);
  };
  return <div className="stack-lg">
    <button className="text-button left" onClick={onBack}><ArrowLeft size={16}/> Volver a proyectos</button>
    <div className="project-detail-hero">
      <div className="project-detail-art"><div className="skyline"><span/><span/><span/><span/></div><div className="detail-token">{liveProject.symbol}</div></div>
      <div className="project-detail-copy"><div className="project-detail-top"><Badge status={liveProject.status}/><span>{liveProject.type}</span></div><h1>{liveProject.name}</h1><p>{liveProject.summary}</p><div className="detail-key-stats"><div><span>Retorno objetivo</span><b>{liveProject.apr}% anual</b></div><div><span>Plazo</span><b>{liveProject.termMonths} meses</b></div><div><span>Deadline</span><b>{dateFmt(liveProject.deadline)}</b></div></div></div>
    </div>
    <div className="detail-layout">
      <div className="stack-lg">
        <Card>
          <div className="panel-heading"><div><h2>Estado de la colocación</h2><p>Fondos válidamente invertidos en mercado primario.</p></div><b className="big-percent">{Math.round(liveProject.raised/liveProject.hardCap*100)}%</b></div>
          <Progress value={liveProject.raised} max={liveProject.hardCap}/>
          <div className="funding-grid"><div><span>Colocado</span><b>{money(liveProject.raised)}</b></div><div><span>Soft cap</span><b>{money(liveProject.softCap)}</b></div><div><span>Hard cap</span><b>{money(liveProject.hardCap)}</b></div><div><span>Tu posición</span><b>{money(inv,'tokens')}</b></div></div>
          <div className={`softcap-note ${liveProject.raised>=liveProject.softCap?'success':''}`}><CircleCheck size={18}/><span>{liveProject.raised>=liveProject.softCap?'El soft cap fue alcanzado. El proyecto quedó exitosamente fondeado.':`Faltan ${money(Math.max(0,liveProject.softCap-liveProject.raised))} para alcanzar el soft cap.`}</span></div>
        </Card>
        <Card>
          <div className="panel-heading"><div><h2>Sobre el proyecto</h2><p>Información comercial y documentación relevante.</p></div></div>
          <div className="about-grid"><div><small>Ubicación</small><b>{liveProject.city}</b></div><div><small>Instrumento</small><b>Representación digital</b></div><div><small>Activo de pago</small><b>USDC</b></div><div><small>Token</small><b>{liveProject.tokenName}</b></div></div>
          <h4 className="subheading">Documentación</h4>
          <div className="doc-list">{liveProject.docs.map(doc=><button key={doc}><FileText size={18}/><span><b>{doc}</b><small>Documento de demo · PDF simulado</small></span><Eye size={17}/></button>)}</div>
        </Card>
      </div>
      <div className="stack-lg detail-side">
        <Card className="invest-box">
          <h2>Invertir en {liveProject.symbol}</h2><p>Completá la adhesión y luego elegí el monto a invertir.</p>
          <div className="invest-step done"><span><Check/></span><div><b>KYC verificado</b><small>{user.kyc==='approved'?'Identidad habilitada':'Pendiente'}</small></div></div>
          <div className={`invest-step ${sub?'done':''}`}><span>{sub?<Check/>:<FileSignature/>}</span><div><b>Suscripción al proyecto</b><small>{sub?'Documento firmado':'Requiere OTP, consentimiento y firma'}</small></div></div>
          <div className="invest-step"><span><WalletCards/></span><div><b>Saldo disponible</b><small>{money(user.balanceUsdc)}</small></div></div>
          {!sub ? <button className="btn btn-primary btn-block" onClick={()=>setSignModal(true)}>Firmar suscripción <ArrowRight size={16}/></button> : <button className="btn btn-primary btn-block" disabled={liveProject.status!=='funding'} onClick={()=>setInvestModal(true)}>Invertir ahora <ArrowRight size={16}/></button>}
          <small className="legal-small">Operación simulada. No se mueve dinero real ni se envían transacciones a blockchain.</small>
        </Card>
      </div>
    </div>
    {signModal && <Modal title="Firmar suscripción" subtitle={`Adhesión a ${liveProject.name}`} onClose={()=>setSignModal(false)}>
      <div className="modal-body stack-md"><div className="signature-doc"><FileSignature/><div><b>Contrato de suscripción · {liveProject.symbol}</b><small>Generado para {user.name} · {user.wallet}</small></div></div><div className="field"><label>OTP de validación</label><input value={otp} onChange={e=>setOtp(e.target.value)}/><small>En la demo usá 123456.</small></div><label className="check-row"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>Acepto el contenido del documento y presto mi consentimiento para firmarlo.</span></label><div className="fake-signature"><span>{consent?user.name:'Tu firma aparecerá aquí'}</span></div></div>
      <div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setSignModal(false)}>Cancelar</button><button className="btn btn-primary" disabled={otp!=='123456'||!consent} onClick={sign}>Firmar documento <FileSignature size={16}/></button></div>
    </Modal>}
    {investModal && <Modal title={`Invertir en ${liveProject.symbol}`} subtitle="Mercado primario · operación simulada" onClose={()=>setInvestModal(false)}>
      <div className="modal-body stack-md"><div className="amount-box"><label>Monto a invertir</label><div><input type="number" min="1" value={amount} onChange={e=>setAmount(e.target.value)}/><span>USDC</span></div><small>Saldo disponible: {money(user.balanceUsdc)}</small></div><div className="trade-summary"><div><span>Precio del token</span><b>1,00 USDC</b></div><div><span>Tokens a recibir</span><b>{Number(amount||0).toLocaleString('es-AR')} {liveProject.symbol}</b></div><div><span>Destino de fondos</span><b>Escrow del proyecto</b></div></div><div className="info-box"><ShieldCheck size={17}/><span>Se simulan las validaciones de KYC, adhesión, límites, hard cap y saldo antes de confirmar.</span></div></div>
      <div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setInvestModal(false)}>Cancelar</button><button className="btn btn-primary" onClick={invest}>Confirmar inversión <ArrowRight size={16}/></button></div>
    </Modal>}
  </div>;
}

function Holdings({ user, investments, data, onProject }) {
  const grouped = Object.values(investments.reduce((acc,i)=>{const project=data.projects.find(p=>p.id===i.projectId);if(!project)return acc;if(!acc[i.projectId])acc[i.projectId]={id:i.projectId,project,tokens:0,invested:0};acc[i.projectId].tokens+=i.tokens;acc[i.projectId].invested+=i.invested;return acc;},{}));
  const total=grouped.reduce((s,i)=>s+i.tokens,0);
  return <div className="stack-lg">
    <div className="stats-grid three"><Stat icon={WalletCards} label="Valor nominal" value={money(total)} note="1 token = 1 USDC nominal"/><Stat icon={Layers3} label="Posiciones activas" value={grouped.length} note="Proyectos con tenencia"/><Stat icon={ShieldCheck} label="Wallet vinculada" value={user.wallet} note={`Global ID ${user.globalUserId}`}/></div>
    <Card><div className="panel-heading"><div><h2>Portfolio</h2><p>Detalle de tus representaciones digitales.</p></div></div>{grouped.length ? <div className="holding-list">{grouped.map(i=><button key={i.id} onClick={()=>onProject(i.project)}><span className="holding-token">{i.project.symbol.slice(0,2)}</span><div className="holding-main"><b>{i.project.name}</b><small>{i.project.symbol} · {i.project.city}</small></div><div><small>Tenencia</small><b>{i.tokens.toLocaleString('es-AR')} {i.project.symbol}</b></div><div><small>Valor nominal</small><b>{money(i.tokens)}</b></div><Badge status={i.project.status}/><ChevronRight/></button>)}</div> : <Empty icon={WalletCards} title="Todavía no tenés inversiones" text="Cuando compres un token, tu posición aparecerá acá."/>}</Card>
  </div>;
}

function TransactionList({ txs }) {
  const typeIcon = {deposit_usdc:ArrowDownLeft,deposit_fiat:Landmark,investment:ShoppingCart,interest:HandCoins,capital:Coins,refund:Undo2,withdraw_usdc:ArrowUpRight,withdraw_fiat:Banknote,secondary_buy:ShoppingCart,secondary_sell:TrendingUp};
  return <div className="tx-list">{txs.length?txs.map(t=>{const Icon=typeIcon[t.type]||ReceiptText;return <div key={t.id}><span className={`tx-icon ${t.amount>=0?'positive':'negative'}`}><Icon/></span><div className="tx-main"><b>{t.description}</b><small>{dateFmt(t.createdAt)}</small></div><div className={t.amount>=0?'positive-text':'negative-text'}><b>{t.amount>0?'+':''}{money(t.amount,t.currency)}</b><small>{statusLabels[t.status]||t.status}</small></div></div>}):<Empty title="Sin movimientos" text="Tu actividad aparecerá en esta sección."/>}</div>;
}

function Movements({ txs }) {
  const [filter,setFilter]=useState('all');
  const list=filter==='all'?txs:txs.filter(t=>filter==='in'?t.amount>0:t.amount<0);
  return <Card><div className="panel-heading"><div><h2>Historial de cuenta</h2><p>Todos los movimientos simulados asociados a este tenant.</p></div><div className="segmented"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Todos</button><button className={filter==='in'?'active':''} onClick={()=>setFilter('in')}>Ingresos</button><button className={filter==='out'?'active':''} onClick={()=>setFilter('out')}>Egresos</button></div></div><TransactionList txs={list}/></Card>;
}

function Funds({ user, onToast }) {
  const { mutate }=useStore();
  const [deposit,setDeposit]=useState(null);
  const [withdraw,setWithdraw]=useState(null);
  const [amount,setAmount]=useState('1000');
  const [address,setAddress]=useState(user.savedAddresses?.[0]||'');
  const [ars,setArs]=useState('1500000');
  const approveAml=()=>{mutate(d=>{d.users.filter(u=>u.globalUserId===user.globalUserId).forEach(u=>u.aml='approved')});onToast('AML simulado aprobado para la identidad global.');};
  const doDeposit=(mode)=>{
    const n=mode==='fiat'?Number(ars)/1200:Number(amount);
    if(!n||n<=0)return;
    if(mode==='fiat'&&n>1500&&user.aml!=='approved')return onToast('Primero completá AML para una compra superior al umbral configurado.');
    mutate(d=>{const u=d.users.find(x=>x.id===user.id);u.balanceUsdc+=n;d.transactions.unshift({id:uid('t'),userId:user.id,tenantId:user.tenantId,type:mode==='fiat'?'deposit_fiat':'deposit_usdc',amount:n,currency:'USDC',status:'completed',description:mode==='fiat'?'Compra de USDC con pesos vía Bitbase':'Ingreso de USDC desde wallet externa',createdAt:new Date().toISOString()})});
    setDeposit(null);onToast(`${money(n)} acreditados en la demo.`);
  };
  const doWithdraw=(mode)=>{
    const n=Number(amount);if(!n||n<=0)return;if(n>user.balanceUsdc)return onToast('Saldo insuficiente.');
    mutate(d=>{const u=d.users.find(x=>x.id===user.id);u.balanceUsdc-=n;if(mode==='usdc'&&address&&!u.savedAddresses?.includes(address)){u.savedAddresses=[...(u.savedAddresses||[]),address]}d.transactions.unshift({id:uid('t'),userId:user.id,tenantId:user.tenantId,type:mode==='usdc'?'withdraw_usdc':'withdraw_fiat',amount:-n,currency:'USDC',status:'completed',description:mode==='usdc'?`Retiro de USDC a ${address}`:'Retiro en pesos vía Bitbase',createdAt:new Date().toISOString()})});
    setWithdraw(null);onToast('Retiro simulado correctamente.');
  };
  return <div className="stack-lg">
    <div className="balance-hero"><div><span>Saldo disponible</span><strong>{money(user.balanceUsdc)}</strong><small>Wallet {user.wallet}</small></div><div className="balance-actions"><button className="btn btn-white" onClick={()=>setDeposit('choice')}><ArrowDownLeft/>Ingresar</button><button className="btn btn-outline-light" onClick={()=>setWithdraw('choice')}><ArrowUpRight/>Retirar</button></div></div>
    <div className="stats-grid two"><Card className="fund-option"><div className="feature-icon"><ShieldCheck/></div><div><span>Verificación de identidad</span><h3>{user.kyc==='approved'?'KYC aprobado':'KYC pendiente'}</h3><p>Estado compartido con tu identidad global.</p></div><Badge status={user.kyc}/></Card><Card className="fund-option"><div className="feature-icon"><ClipboardCheck/></div><div><span>Origen de fondos</span><h3>{user.aml==='approved'?'AML aprobado':'AML pendiente'}</h3><p>Se solicita al superar el umbral configurado.</p></div>{user.aml!=='approved'?<button className="btn btn-secondary" onClick={approveAml}>Simular AML</button>:<Badge status="approved"/>}</Card></div>
    <Card><div className="panel-heading"><div><h2>Formas de fondeo</h2><p>En la demo ambas acreditan el saldo inmediatamente.</p></div></div><div className="funding-methods"><button onClick={()=>setDeposit('usdc')}><span><Coins/></span><div><b>Ingresar USDC</b><small>Simular una transferencia desde otra wallet</small></div><ChevronRight/></button><button onClick={()=>setDeposit('fiat')}><span><Landmark/></span><div><b>Comprar USDC con pesos</b><small>Simular on ramp y acreditación vía Bitbase</small></div><ChevronRight/></button></div></Card>
    {deposit && <Modal title="Ingresar fondos" subtitle={deposit==='fiat'?'Compra simulada vía Bitbase':'Transferencia simulada de USDC'} onClose={()=>setDeposit(null)}>
      <div className="modal-body stack-md">{deposit==='choice'?<div className="choice-grid"><button onClick={()=>setDeposit('usdc')}><Coins/><b>USDC</b><small>Desde wallet externa</small></button><button onClick={()=>setDeposit('fiat')}><Landmark/><b>Pesos</b><small>Compra vía Bitbase</small></button></div>:deposit==='usdc'?<><div className="field"><label>Monto</label><div className="input-unit"><input type="number" value={amount} onChange={e=>setAmount(e.target.value)}/><span>USDC</span></div></div><div className="fake-address"><small>Tu wallet habilitada</small><b>{user.wallet}</b></div></>:<><div className="field"><label>Monto a transferir</label><div className="input-unit"><input type="number" value={ars} onChange={e=>setArs(e.target.value)}/><span>ARS</span></div></div><div className="trade-summary"><div><span>Cotización demo</span><b>1 USDC = 1.200 ARS</b></div><div><span>Recibís aprox.</span><b>{money(Number(ars||0)/1200)}</b></div></div>{Number(ars)/1200>1500&&user.aml!=='approved'&&<div className="warning-box"><AlertTriangle/><span>Este monto supera el umbral AML. Completá la validación antes de continuar.</span></div>}</>}</div>
      {deposit!=='choice'&&<div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setDeposit(null)}>Cancelar</button><button className="btn btn-primary" onClick={()=>doDeposit(deposit)}>{deposit==='fiat'?'Simular transferencia':'Acreditar USDC'}</button></div>}
    </Modal>}
    {withdraw && <Modal title="Retirar fondos" subtitle="Elegí cómo querés recibir tu saldo" onClose={()=>setWithdraw(null)}>
      <div className="modal-body stack-md">{withdraw==='choice'?<div className="choice-grid"><button onClick={()=>setWithdraw('usdc')}><Coins/><b>USDC</b><small>A una wallet externa</small></button><button onClick={()=>setWithdraw('fiat')}><Banknote/><b>Pesos</b><small>A tu cuenta bancaria</small></button></div>:<><div className="field"><label>Monto a retirar</label><div className="input-unit"><input type="number" value={amount} onChange={e=>setAmount(e.target.value)}/><span>USDC</span></div><small>Disponible: {money(user.balanceUsdc)}</small></div>{withdraw==='usdc'?<div className="field"><label>Address destino</label><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="0x..."/><small>Las addresses usadas quedan guardadas como destinos frecuentes.</small></div>:<div className="info-box"><Landmark/><span>Bitbase recibirá los USDC simulados y acreditará pesos en la cuenta bancaria declarada.</span></div>}</>}</div>
      {withdraw!=='choice'&&<div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setWithdraw(null)}>Cancelar</button><button className="btn btn-primary" onClick={()=>doWithdraw(withdraw)}>Confirmar retiro</button></div>}
    </Modal>}
  </div>;
}

function Secondary({ user, onToast }) {
  const { data, mutate }=useStore();
  const [sell,setSell]=useState(false);const [projectId,setProjectId]=useState('');const [amount,setAmount]=useState('100');const [price,setPrice]=useState('1.00');
  const orders=data.secondaryOrders.filter(o=>o.tenantId===user.tenantId&&o.status==='open'&&o.remaining>0);
  const holdings=Object.values(data.investments.filter(i=>i.userId===user.id&&i.tokens>0).reduce((acc,i)=>{const p=data.projects.find(x=>x.id===i.projectId);if(!p)return acc;if(!acc[p.id])acc[p.id]={p,tokens:0};acc[p.id].tokens+=i.tokens;return acc;},{}));
  React.useEffect(()=>{if(!projectId&&holdings[0])setProjectId(holdings[0].p.id)},[projectId,holdings]);
  const buy=(order)=>{
    const total=order.remaining*order.price;if(user.kyc!=='approved'||user.frozen)return onToast('La cuenta no está habilitada para operar.');if(total>user.balanceUsdc)return onToast('Saldo insuficiente para comprar esta orden.');const globalIds=new Set(data.users.filter(u=>u.globalUserId===user.globalUserId).map(u=>u.id));const globalPosition=data.investments.filter(i=>globalIds.has(i.userId)).reduce((s,i)=>s+i.tokens,0)+order.remaining;if(globalPosition>1500&&user.aml!=='approved')return onToast('La compra requiere AML aprobado por la posición neta global.');
    mutate(d=>{
      const buyer=d.users.find(u=>u.id===user.id);const seller=d.users.find(u=>u.id===order.sellerUserId);buyer.balanceUsdc-=total;if(seller)seller.balanceUsdc+=total;
      let left=order.remaining;d.investments.filter(i=>i.userId===order.sellerUserId&&i.projectId===order.projectId&&i.tokens>0).forEach(i=>{if(left<=0)return;const take=Math.min(i.tokens,left);i.tokens-=take;left-=take;});
      d.investments.push({id:uid('i'),userId:user.id,projectId:order.projectId,tokens:order.remaining,invested:total,createdAt:new Date().toISOString()});
      const o=d.secondaryOrders.find(x=>x.id===order.id);o.remaining=0;o.status='completed';
      const p=d.projects.find(x=>x.id===order.projectId);
      d.transactions.unshift({id:uid('t'),userId:user.id,tenantId:user.tenantId,projectId:p.id,type:'secondary_buy',amount:-total,currency:'USDC',status:'completed',description:`Compra secundaria de ${p.symbol}`,createdAt:new Date().toISOString()});
      if(seller)d.transactions.unshift({id:uid('t'),userId:seller.id,tenantId:seller.tenantId,projectId:p.id,type:'secondary_sell',amount:total,currency:'USDC',status:'completed',description:`Venta secundaria de ${p.symbol}`,createdAt:new Date().toISOString()});
    });onToast('Compra secundaria simulada. La tenencia fue transferida.');
  };
  const createOrder=()=>{const n=Number(amount),p=Number(price);const h=holdings.find(x=>x.p.id===projectId);const committed=data.secondaryOrders.filter(o=>o.sellerUserId===user.id&&o.projectId===projectId&&o.status==='open').reduce((s,o)=>s+o.remaining,0);const available=(h?.tokens||0)-committed;if(!h||n<=0||n>available)return onToast('No tenés suficiente tenencia libre para publicar esa orden.');mutate(d=>d.secondaryOrders.unshift({id:uid('o'),tenantId:user.tenantId,projectId,sellerUserId:user.id,amount:n,price:p,remaining:n,status:'open',createdAt:new Date().toISOString()}));setSell(false);onToast('Orden de venta publicada.');};
  return <div className="stack-lg"><div className="section-action"><div><h2>Órdenes disponibles</h2><p>Mercado secundario simulado dentro de esta plataforma.</p></div><button className="btn btn-primary" onClick={()=>setSell(true)}><Plus size={16}/> Publicar venta</button></div><Card>{orders.length?<div className="order-list">{orders.map(o=>{const p=data.projects.find(x=>x.id===o.projectId),seller=data.users.find(x=>x.id===o.sellerUserId);return <div key={o.id}><span className="holding-token">{p?.symbol.slice(0,2)}</span><div className="order-main"><b>{p?.name}</b><small>Vende {seller?.name||'Inversor'} · {o.remaining} {p?.symbol}</small></div><div><small>Precio</small><b>{o.price.toFixed(2)} USDC</b></div><div><small>Total</small><b>{money(o.remaining*o.price)}</b></div>{o.sellerUserId===user.id?<Badge status="open">Tu orden</Badge>:<button className="btn btn-secondary" onClick={()=>buy(o)}>Comprar</button>}</div>})}</div>:<Empty icon={Store} title="No hay órdenes abiertas" text="Podés publicar una venta desde tus tenencias."/>}</Card><div className="info-box"><Info/><span>El mock representa el flujo operativo. No modela matching avanzado, gas, settlement real ni book de órdenes on chain.</span></div>
    {sell&&<Modal title="Publicar orden de venta" subtitle="Mercado secundario simulado" onClose={()=>setSell(false)}><div className="modal-body stack-md"><div className="field"><label>Token</label><select value={projectId} onChange={e=>setProjectId(e.target.value)}>{holdings.map(({p,tokens})=>{const committed=data.secondaryOrders.filter(o=>o.sellerUserId===user.id&&o.projectId===p.id&&o.status==='open').reduce((s,o)=>s+o.remaining,0);return <option key={p.id} value={p.id}>{p.symbol} · disponible {Math.max(0,tokens-committed)}</option>})}</select></div><div className="field"><label>Cantidad</label><input type="number" value={amount} onChange={e=>setAmount(e.target.value)}/></div><div className="field"><label>Precio por token</label><div className="input-unit"><input type="number" step="0.01" value={price} onChange={e=>setPrice(e.target.value)}/><span>USDC</span></div></div></div><div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setSell(false)}>Cancelar</button><button className="btn btn-primary" onClick={createOrder}>Publicar orden</button></div></Modal>}
  </div>;
}
function TenantApp({ user, onExit }) {
  const { data } = useStore();
  const tenant = data.tenants.find(t=>t.id===user.tenantId);
  const [active,setActive]=useState('dashboard');
  const [toast,setToast]=useState('');
  const nav=[
    {id:'dashboard',label:'Dashboard',icon:LayoutDashboard},
    {id:'projects',label:'Proyectos',icon:Building2},
    {id:'investors',label:'Inversores',icon:Users},
    {id:'issuance',label:'Emisiones',icon:Coins,badge:data.issuanceRequests.filter(r=>r.tenantId===user.tenantId&&r.status==='pending').length||null},
    {id:'distributions',label:'Distribuciones',icon:HandCoins},
    {id:'settings',label:'Configuración',icon:Settings},
  ];
  const titles={dashboard:'Dashboard',projects:'Proyectos',investors:'Inversores',issuance:'Emisiones',distributions:'Distribuciones',settings:'Configuración'};
  const subtitles={dashboard:`Resumen operativo de ${tenant?.name}.`,projects:'Gestioná únicamente los activos de esta plataforma.',investors:'Usuarios vinculados a tu tenant y sus posiciones.',issuance:'Solicitá nuevas emisiones a la capa central.',distributions:'Simulá pagos de intereses y devolución de capital.',settings:'Wallet de recepción y datos operativos del tenant.'};
  return <>
    <AppFrame user={user} tenant={tenant} title={titles[active]} subtitle={subtitles[active]} nav={nav} active={active} setActive={setActive} onExit={onExit}>
      {active==='dashboard'&&<TenantDashboard user={user} tenant={tenant}/>} 
      {active==='projects'&&<TenantProjects user={user} tenant={tenant} onToast={setToast}/>} 
      {active==='investors'&&<TenantInvestors user={user}/>} 
      {active==='issuance'&&<TenantIssuance user={user} onToast={setToast}/>} 
      {active==='distributions'&&<TenantDistributions user={user} onToast={setToast}/>} 
      {active==='settings'&&<TenantSettings tenant={tenant} onToast={setToast}/>} 
    </AppFrame>
    {toast&&<Toast message={toast} onDone={()=>setToast('')}/>} 
  </>;
}

function TenantDashboard({ user, tenant }) {
  const {data}=useStore();
  const projects=data.projects.filter(p=>p.tenantId===user.tenantId);
  const investorIds=new Set(data.users.filter(u=>u.tenantId===user.tenantId&&u.role==='investor').map(u=>u.id));
  const investors=investorIds.size;
  const raised=projects.reduce((s,p)=>s+p.raised,0);
  const active=projects.filter(p=>p.status==='funding').length;
  const recent=data.transactions.filter(t=>t.tenantId===user.tenantId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,6);
  return <div className="stack-xl">
    <div className="stats-grid four"><Stat icon={CircleDollarSign} label="Capital colocado" value={money(raised)} note="Todos los proyectos"/><Stat icon={Building2} label="Proyectos" value={projects.length} note={`${active} en colocación`}/><Stat icon={Users} label="Inversores" value={investors} note="Cuentas de este tenant"/><Stat icon={ShieldCheck} label="Estado" value="Operativo" note="Tenant activo" tone="success"/></div>
    <div className="split-main"><Card><div className="panel-heading"><div><h2>Proyectos</h2><p>Estado de las emisiones de {tenant.name}.</p></div></div><div className="tenant-project-summary">{projects.map(p=><div key={p.id}><span className="holding-token">{p.symbol.slice(0,2)}</span><div><b>{p.name}</b><small>{p.symbol} · {statusLabels[p.status]}</small></div><div className="mini-progress"><Progress compact value={p.raised} max={p.hardCap}/><small>{money(p.raised)} de {money(p.hardCap)}</small></div><Badge status={p.status}/></div>)}</div></Card><Card><div className="panel-heading"><div><h2>Última actividad</h2><p>Movimientos del tenant.</p></div></div><TransactionList txs={recent}/></Card></div>
  </div>;
}

function TenantProjects({ user, onToast }) {
  const {data,mutate}=useStore();
  const projects=data.projects.filter(p=>p.tenantId===user.tenantId);
  const [selected,setSelected]=useState(null);
  const live=selected?data.projects.find(p=>p.id===selected.id):null;
  const releaseEscrow=(p)=>{if(p.raised<p.softCap)return onToast('Todavía no se alcanzó el soft cap.');mutate(d=>{const x=d.projects.find(q=>q.id===p.id);x.escrowReleased=true;x.escrowBalance=0;x.status='funded';d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Liberación de escrow',detail:p.symbol,createdAt:new Date().toISOString()})});onToast('Fondos del escrow liberados al emisor en la simulación.');};
  const failAndRefund=(p)=>{if(p.raised>=p.softCap)return onToast('El proyecto ya alcanzó el soft cap.');if(!confirm('¿Simular vencimiento sin soft cap? Se devolverán los USDC y se quemarán las tenencias activas.'))return;mutate(d=>{const invs=d.investments.filter(i=>i.projectId===p.id&&i.tokens>0);invs.forEach(i=>{const u=d.users.find(x=>x.id===i.userId);const refund=i.tokens;if(u)u.balanceUsdc+=refund;d.transactions.unshift({id:uid('t'),userId:i.userId,tenantId:user.tenantId,projectId:p.id,type:'refund',amount:refund,currency:'USDC',status:'completed',description:`Refund por colocación fallida ${p.symbol}`,createdAt:new Date().toISOString()});i.tokens=0;});const x=d.projects.find(q=>q.id===p.id);x.status='failed';x.escrowBalance=0;d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Colocación fallida y refunds',detail:p.symbol,createdAt:new Date().toISOString()})});onToast('Refunds ejecutados y tenencias quemadas en la simulación.');};
  const togglePublish=(p)=>{mutate(d=>{const x=d.projects.find(q=>q.id===p.id);x.status=x.status==='draft'?'funding':'draft'});onToast('Estado del proyecto actualizado.');};
  if(live)return <div className="stack-lg"><button className="text-button left" onClick={()=>setSelected(null)}><ArrowLeft size={16}/> Volver</button><div className="section-action"><div><div className="inline-badges"><Badge status={live.status}/><span className="token-chip inline">{live.symbol}</span></div><h2 className="large-title">{live.name}</h2><p>{live.city} · {live.type}</p></div><div className="button-row">{live.status==='draft'&&<button className="btn btn-primary" onClick={()=>togglePublish(live)}>Publicar proyecto</button>}{live.status==='funding'&&live.raised>=live.softCap&&!live.escrowReleased&&<button className="btn btn-primary" onClick={()=>releaseEscrow(live)}>Liberar escrow</button>}{live.status==='funding'&&live.raised<live.softCap&&<button className="btn btn-ghost" onClick={()=>failAndRefund(live)}>Simular vencimiento y refund</button>}</div></div><div className="stats-grid four"><Stat icon={CircleDollarSign} label="Colocado" value={money(live.raised)} note={`Hard cap ${money(live.hardCap)}`}/><Stat icon={Landmark} label="Escrow" value={money(live.escrowBalance)} note={live.escrowReleased?'Liberado':'Bloqueado'}/><Stat icon={Users} label="Inversores" value={new Set(data.investments.filter(i=>i.projectId===live.id&&i.tokens>0).map(i=>i.userId)).size} note="Con posición activa"/><Stat icon={Clock3} label="Deadline" value={dateFmt(live.deadline)} note={`${live.termMonths} meses objetivo`}/></div><Card><div className="panel-heading"><div><h2>Colocación</h2><p>Progreso hacia soft y hard cap.</p></div></div><Progress value={live.raised} max={live.hardCap}/><div className="funding-grid"><div><span>Soft cap</span><b>{money(live.softCap)}</b></div><div><span>Hard cap</span><b>{money(live.hardCap)}</b></div><div><span>Escrow</span><b>{live.escrowReleased?'Liberado':'Custodiado'}</b></div><div><span>Token</span><b>{live.symbol}</b></div></div></Card><Card><div className="panel-heading"><div><h2>Inversores del proyecto</h2><p>Posiciones visibles sólo para este tenant.</p></div></div><ProjectInvestors projectId={live.id}/></Card></div>;
  return <div className="stack-lg"><div className="project-grid admin-grid">{projects.map(p=><ProjectCard key={p.id} project={p} onClick={()=>setSelected(p)}/>)}</div></div>;
}

function ProjectInvestors({ projectId }) {
  const {data}=useStore();
  const rows=Object.values(data.investments.filter(i=>i.projectId===projectId&&i.tokens>0).reduce((acc,i)=>{const usr=data.users.find(u=>u.id===i.userId);if(!usr)return acc;if(!acc[i.userId])acc[i.userId]={id:i.userId,user:usr,tokens:0};acc[i.userId].tokens+=i.tokens;return acc;},{}));
  return rows.length?<div className="table-wrap"><table><thead><tr><th>Inversor</th><th>Global ID</th><th>Wallet</th><th>Tenencia</th><th>KYC</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.user.name}</b><small>{r.user.email}</small></td><td>{r.user.globalUserId}</td><td><code>{r.user.wallet}</code></td><td><b>{r.tokens.toLocaleString('es-AR')}</b></td><td><Badge status={r.user.kyc}/></td></tr>)}</tbody></table></div>:<Empty icon={Users} title="Sin inversores" text="Las inversiones aparecerán aquí."/>;
}

function TenantInvestors({ user }) {
  const {data}=useStore();
  const users=data.users.filter(u=>u.tenantId===user.tenantId&&u.role==='investor');
  return <Card><div className="panel-heading"><div><h2>Inversores del tenant</h2><p>No se muestran usuarios de otras plataformas.</p></div></div><div className="table-wrap"><table><thead><tr><th>Usuario</th><th>Identidad global</th><th>Wallet</th><th>KYC</th><th>AML</th><th>Posición</th></tr></thead><tbody>{users.map(u=>{const pos=data.investments.filter(i=>i.userId===u.id).reduce((s,i)=>s+i.tokens,0);return <tr key={u.id}><td><b>{u.name}</b><small>{u.email}</small></td><td>{u.globalUserId}</td><td><code>{u.wallet}</code></td><td><Badge status={u.kyc}/></td><td><Badge status={u.aml}/></td><td><b>{money(pos)}</b></td></tr>})}</tbody></table></div></Card>;
}

function TenantIssuance({ user, onToast }) {
  const {data,mutate}=useStore();
  const [modal,setModal]=useState(false);
  const [form,setForm]=useState({projectName:'',symbol:'',softCap:'200000',hardCap:'350000',deadline:'2027-03-31'});
  const requests=data.issuanceRequests.filter(r=>r.tenantId===user.tenantId).sort((a,b)=>new Date(b.requestedAt)-new Date(a.requestedAt));
  const submit=()=>{if(!form.projectName||!form.symbol)return;mutate(d=>{d.issuanceRequests.unshift({id:uid('req'),tenantId:user.tenantId,requestedBy:user.id,status:'pending',projectName:form.projectName,symbol:form.symbol.toUpperCase(),softCap:Number(form.softCap),hardCap:Number(form.hardCap),deadline:form.deadline,requestedAt:new Date().toISOString()});d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Solicitud de emisión',detail:`${form.projectName} · ${form.symbol.toUpperCase()}`,createdAt:new Date().toISOString()})});setModal(false);onToast('Solicitud enviada al Master Backoffice.');};
  return <div className="stack-lg"><div className="section-action"><div><h2>Solicitudes de emisión</h2><p>El Master Admin revisa y aprueba las nuevas emisiones.</p></div><button className="btn btn-primary" onClick={()=>setModal(true)}><Plus size={16}/> Nueva solicitud</button></div><Card>{requests.length?<div className="request-list">{requests.map(r=><div key={r.id}><span className="holding-token">{r.symbol.slice(0,2)}</span><div><b>{r.projectName}</b><small>Solicitada {dateFmt(r.requestedAt)}</small></div><div><small>Soft cap</small><b>{money(r.softCap)}</b></div><div><small>Hard cap</small><b>{money(r.hardCap)}</b></div><Badge status={r.status}/></div>)}</div>:<Empty icon={Coins} title="Sin solicitudes" text="Podés pedir una nueva emisión al administrador central."/>}</Card>{modal&&<Modal title="Solicitar nueva emisión" subtitle="La solicitud quedará pendiente de aprobación central" onClose={()=>setModal(false)}><div className="modal-body form-grid"><div className="field full"><label>Nombre del proyecto</label><input value={form.projectName} onChange={e=>setForm({...form,projectName:e.target.value})} placeholder="Ej. Madero Studios III"/></div><div className="field"><label>Símbolo del token</label><input value={form.symbol} onChange={e=>setForm({...form,symbol:e.target.value})} placeholder="MSTD" maxLength={8}/></div><div className="field"><label>Deadline</label><input type="date" value={form.deadline} onChange={e=>setForm({...form,deadline:e.target.value})}/></div><div className="field"><label>Soft cap</label><input type="number" value={form.softCap} onChange={e=>setForm({...form,softCap:e.target.value})}/></div><div className="field"><label>Hard cap</label><input type="number" value={form.hardCap} onChange={e=>setForm({...form,hardCap:e.target.value})}/></div></div><div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-primary" onClick={submit}>Enviar solicitud <Send size={16}/></button></div></Modal>}</div>;
}

function TenantDistributions({ user, onToast }) {
  const {data,mutate}=useStore();
  const projects=data.projects.filter(p=>p.tenantId===user.tenantId&&['funded','funding'].includes(p.status));
  const [projectId,setProjectId]=useState(projects[0]?.id||'');const [type,setType]=useState('interest');const [amount,setAmount]=useState('10000');
  const distribute=()=>{const n=Number(amount);const p=data.projects.find(x=>x.id===projectId);if(!p||n<=0)return;const invs=data.investments.filter(i=>i.projectId===projectId&&i.tokens>0);const total=invs.reduce((s,i)=>s+i.tokens,0);if(!total)return onToast('El proyecto no tiene tenedores activos.');if(type==='capital'&&!confirm('Esto simulará la devolución total de capital y quemará las tenencias del proyecto. ¿Continuar?'))return;mutate(d=>{const liveInv=d.investments.filter(i=>i.projectId===projectId&&i.tokens>0);const liveTotal=liveInv.reduce((s,i)=>s+i.tokens,0);liveInv.forEach(i=>{const share=i.tokens/liveTotal;const pay=n*share;const u=d.users.find(x=>x.id===i.userId);if(u)u.balanceUsdc+=pay;d.transactions.unshift({id:uid('t'),userId:i.userId,tenantId:user.tenantId,projectId,type:type==='interest'?'interest':'capital',amount:pay,currency:'USDC',status:'completed',description:type==='interest'?`Pago de intereses ${p.symbol}`:`Devolución de capital ${p.symbol}`,createdAt:new Date().toISOString()});if(type==='capital')i.tokens=0;});if(type==='capital'){const lp=d.projects.find(x=>x.id===projectId);lp.status='finalized';}d.auditLog.unshift({id:uid('a'),actor:user.name,action:type==='interest'?'Distribución de intereses':'Devolución de capital',detail:`${p.symbol} · ${n} USDC`,createdAt:new Date().toISOString()})});onToast(type==='interest'?'Intereses distribuidos proporcionalmente.':'Capital distribuido y tokens quemados en la simulación.');};
  return <div className="distribution-layout"><Card><div className="panel-heading"><div><h2>Nueva distribución</h2><p>Simulá el pago proporcional a todos los tenedores.</p></div></div><div className="stack-md"><div className="field"><label>Proyecto</label><select value={projectId} onChange={e=>setProjectId(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.symbol} · {p.name}</option>)}</select></div><div className="field"><label>Concepto</label><div className="choice-toggle"><button className={type==='interest'?'active':''} onClick={()=>setType('interest')}><HandCoins/>Intereses</button><button className={type==='capital'?'active':''} onClick={()=>setType('capital')}><Coins/>Devolución de capital</button></div></div><div className="field"><label>Monto total a distribuir</label><div className="input-unit"><input type="number" value={amount} onChange={e=>setAmount(e.target.value)}/><span>USDC</span></div></div><div className={type==='capital'?'warning-box':'info-box'}>{type==='capital'?<AlertTriangle/>:<Info/>}<span>{type==='capital'?'La devolución de capital finalizará el proyecto y quemará todas las tenencias activas.':'Los tokens no se queman. La inversión continúa activa después del pago de intereses.'}</span></div><button className="btn btn-primary btn-block" onClick={distribute}>Simular distribución <ArrowRight size={16}/></button></div></Card><Card><div className="panel-heading"><div><h2>Vista previa</h2><p>Cómo se repartiría el monto actual.</p></div></div><DistributionPreview projectId={projectId} amount={Number(amount||0)}/></Card></div>;
}

function DistributionPreview({projectId,amount}){const{data}=useStore();const invs=data.investments.filter(i=>i.projectId===projectId&&i.tokens>0);const total=invs.reduce((s,i)=>s+i.tokens,0);return invs.length?<div className="preview-list">{invs.map(i=>{const u=data.users.find(x=>x.id===i.userId);const pay=total?amount*i.tokens/total:0;return <div key={i.id}><div><b>{u?.name}</b><small>{i.tokens.toLocaleString('es-AR')} tokens · {((i.tokens/total)*100).toFixed(1)}%</small></div><b>{money(pay)}</b></div>})}</div>:<Empty icon={Users} title="Sin tenedores" text="Elegí un proyecto con posiciones activas."/>}

function TenantSettings({tenant,onToast}){const{mutate}=useStore();const[wallet,setWallet]=useState(tenant.issuerWallet);const save=()=>{mutate(d=>{d.tenants.find(t=>t.id===tenant.id).issuerWallet=wallet;d.projects.filter(p=>p.tenantId===tenant.id).forEach(p=>p.issuerWallet=wallet)});onToast('Configuración guardada.');};return <div className="settings-grid"><Card><div className="panel-heading"><div><h2>Datos del tenant</h2><p>Identidad operativa de la plataforma.</p></div></div><div className="stack-md"><div className="field"><label>Nombre comercial</label><input value={tenant.name} disabled/></div><div className="field"><label>Razón social</label><input value={tenant.legalName} disabled/></div><div className="field"><label>Slug</label><input value={tenant.slug} disabled/></div></div></Card><Card><div className="panel-heading"><div><h2>Wallet del emisor</h2><p>Destino habilitado para fondos liberados del escrow.</p></div></div><div className="stack-md"><div className="field"><label>Address</label><input value={wallet} onChange={e=>setWallet(e.target.value)}/></div><div className="info-box"><ShieldCheck/><span>En producción, este cambio requeriría controles y permisos. En el mock sólo actualiza el estado local.</span></div><button className="btn btn-primary" onClick={save}>Guardar cambios</button></div></Card></div>}
function MasterApp({ user, onExit }) {
  const { data } = useStore();
  const [active,setActive]=useState('dashboard');
  const [toast,setToast]=useState('');
  const pending=data.issuanceRequests.filter(r=>r.status==='pending').length;
  const nav=[
    {id:'dashboard',label:'Resumen global',icon:LayoutDashboard},
    {id:'tenants',label:'Constructoras',icon:Building2},
    {id:'projects',label:'Tokens y proyectos',icon:Coins},
    {id:'requests',label:'Solicitudes',icon:FileCheck2,badge:pending||null},
    {id:'people',label:'Identidad global',icon:Users},
    {id:'holdings',label:'Tenencias globales',icon:WalletCards},
    {id:'regulatory',label:'Reportes regulatorios',icon:Landmark},
    {id:'compliance',label:'Compliance',icon:ShieldAlert},
    {id:'audit',label:'Registro operativo',icon:ScrollText},
  ];
  const titles={dashboard:'Master Backoffice',tenants:'Constructoras',projects:'Tokens y proyectos',requests:'Solicitudes de emisión',people:'Identidad global',holdings:'Tenencias globales',regulatory:'Reportes regulatorios',compliance:'Compliance y control',audit:'Registro operativo'};
  const subtitles={dashboard:'Visión central de toda la operación multi tenant.',tenants:'Creá y administrá nuevas plataformas cliente.',projects:'Gestioná los activos de todas las constructoras.',requests:'Revisá pedidos enviados por los backoffices de clientes.',people:'Relacioná cuentas, wallets, KYC, AML e inversiones por persona.',holdings:'Vista consolidada de posiciones en todas las plataformas.',regulatory:'Vista simulada de eventos que deberían sincronizarse con la ADCVN correspondiente.',compliance:'Acciones regulatorias simuladas sobre usuarios y tokens.',audit:'Trazabilidad de las acciones realizadas en la demo.'};
  return <>
    <AppFrame user={user} title={titles[active]} subtitle={subtitles[active]} nav={nav} active={active} setActive={setActive} onExit={onExit}>
      {active==='dashboard'&&<MasterDashboard/>}
      {active==='tenants'&&<MasterTenants user={user} onToast={setToast}/>} 
      {active==='projects'&&<MasterProjects user={user} onToast={setToast}/>} 
      {active==='requests'&&<MasterRequests user={user} onToast={setToast}/>} 
      {active==='people'&&<MasterPeople/>} 
      {active==='holdings'&&<MasterHoldings/>} 
      {active==='regulatory'&&<MasterRegulatory/>} 
      {active==='compliance'&&<MasterCompliance user={user} onToast={setToast}/>} 
      {active==='audit'&&<AuditLog/>} 
    </AppFrame>
    {toast&&<Toast message={toast} onDone={()=>setToast('')}/>} 
  </>;
}

function MasterDashboard(){
  const{data}=useStore();
  const tenants=data.tenants.filter(t=>t.status==='active');
  const projects=data.projects;
  const investorAccounts=data.users.filter(u=>u.role==='investor');
  const globalPeople=new Set(investorAccounts.map(u=>u.globalUserId)).size;
  const totalRaised=projects.reduce((s,p)=>s+p.raised,0);
  const pending=data.issuanceRequests.filter(r=>r.status==='pending');
  const holdings=data.investments.reduce((s,i)=>s+i.tokens,0);
  return <div className="stack-xl">
    <div className="stats-grid four"><Stat icon={Building2} label="Plataformas activas" value={tenants.length} note="Constructoras operativas"/><Stat icon={Coins} label="Tokens creados" value={projects.length} note={`${projects.filter(p=>p.status==='funding').length} en colocación`}/><Stat icon={Users} label="Personas globales" value={globalPeople} note={`${investorAccounts.length} cuentas por tenant`}/><Stat icon={CircleDollarSign} label="Capital colocado" value={money(totalRaised)} note="Consolidado global"/></div>
    <div className="split-main">
      <Card><div className="panel-heading"><div><h2>Plataformas</h2><p>Vista comparativa del ecosistema.</p></div></div><div className="platform-list">{tenants.map(t=>{const ps=projects.filter(p=>p.tenantId===t.id),raised=ps.reduce((s,p)=>s+p.raised,0),investors=data.users.filter(u=>u.tenantId===t.id&&u.role==='investor').length;return <div key={t.id}><span className="tenant-avatar" style={{background:t.brand}}>{t.name[0]}</span><div><b>{t.name}</b><small>{t.legalName}</small></div><div><small>Proyectos</small><b>{ps.length}</b></div><div><small>Inversores</small><b>{investors}</b></div><div><small>Colocado</small><b>{money(raised)}</b></div><Badge status={t.status}/></div>})}</div></Card>
      <Card><div className="panel-heading"><div><h2>Estado operativo</h2><p>Indicadores de control central.</p></div></div><div className="ops-grid"><div><span className="ops-icon success"><ShieldCheck/></span><b>{globalPeople}</b><small>Identidades consolidadas</small></div><div><span className="ops-icon info"><WalletCards/></span><b>{money(holdings)}</b><small>Tenencia nominal global</small></div><div><span className="ops-icon warning"><FileCheck2/></span><b>{pending.length}</b><small>Solicitudes pendientes</small></div><div><span className="ops-icon"><Network/></span><b>{projects.filter(p=>p.status==='funding').length}</b><small>Escrows activos</small></div></div></Card>
    </div>
    <Card><div className="panel-heading"><div><h2>Actividad reciente</h2><p>Eventos de negocio y administración.</p></div></div><AuditLog compact/></Card>
  </div>;
}

function MasterTenants({user,onToast}){
  const{data,mutate}=useStore();const[modal,setModal]=useState(false);const[form,setForm]=useState({name:'',legalName:'',slug:'',adminName:'',adminEmail:'',issuerWallet:'0x...'});
  const create=()=>{if(!form.name||!form.adminEmail)return;const id=uid('tenant');mutate(d=>{d.tenants.push({id,name:form.name,legalName:form.legalName||form.name,slug:form.slug||form.name.toLowerCase().replace(/\s+/g,'-'),status:'active',brand:['#2457f5','#0f8a72','#8b5cf6','#db6b2f'][d.tenants.length%4],issuerWallet:form.issuerWallet||'0x...',adminEmail:form.adminEmail,createdAt:new Date().toISOString()});d.users.push({id:uid('ta'),globalUserId:`GLOBAL-ADMIN-${Date.now().toString().slice(-4)}`,tenantId:id,role:'tenant_admin',name:form.adminName||'Admin Cliente',email:form.adminEmail,password:'demo123',kyc:'approved',aml:'approved',wallet:'0xADMIN',balanceUsdc:0,frozen:false});d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Plataforma creada',detail:form.name,createdAt:new Date().toISOString()})});setModal(false);onToast('Constructora creada con su backoffice independiente.');};
  return <div className="stack-lg"><div className="section-action"><div><h2>Plataformas cliente</h2><p>Cada constructora mantiene datos, proyectos e inversores aislados por tenant.</p></div><button className="btn btn-primary" onClick={()=>setModal(true)}><Plus size={16}/> Nueva constructora</button></div><div className="tenant-cards">{data.tenants.map(t=>{const ps=data.projects.filter(p=>p.tenantId===t.id),users=data.users.filter(u=>u.tenantId===t.id&&u.role==='investor');return <Card key={t.id} className="tenant-card"><div className="tenant-card-head"><span style={{background:t.brand}}>{t.name[0]}</span><Badge status={t.status}/></div><h3>{t.name}</h3><p>{t.legalName}</p><div className="tenant-card-stats"><div><b>{ps.length}</b><small>Proyectos</small></div><div><b>{users.length}</b><small>Inversores</small></div><div><b>{money(ps.reduce((s,p)=>s+p.raised,0))}</b><small>Colocado</small></div></div><div className="tenant-card-foot"><span><KeyRound size={15}/>{t.adminEmail}</span><span><WalletCards size={15}/>{t.issuerWallet}</span></div></Card>})}</div>{modal&&<Modal title="Crear nueva constructora" subtitle="Se generará un tenant y un usuario administrador demo" onClose={()=>setModal(false)} wide><div className="modal-body form-grid"><div className="field"><label>Nombre comercial</label><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Ej. Horizonte Real Estate"/></div><div className="field"><label>Razón social</label><input value={form.legalName} onChange={e=>setForm({...form,legalName:e.target.value})} placeholder="Horizonte Real Estate S.A."/></div><div className="field"><label>Slug</label><input value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="horizonte-real-estate"/></div><div className="field"><label>Wallet emisor</label><input value={form.issuerWallet} onChange={e=>setForm({...form,issuerWallet:e.target.value})}/></div><div className="field"><label>Nombre del admin</label><input value={form.adminName} onChange={e=>setForm({...form,adminName:e.target.value})} placeholder="Nombre Apellido"/></div><div className="field"><label>Email del admin</label><input type="email" value={form.adminEmail} onChange={e=>setForm({...form,adminEmail:e.target.value})} placeholder="admin@horizonte.com"/></div><div className="info-box full"><Info/><span>La contraseña demo del nuevo administrador será <b>demo123</b>. La cuenta podrá usarse inmediatamente desde “Cambiar rol demo”.</span></div></div><div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-primary" onClick={create}>Crear plataforma <Plus size={16}/></button></div></Modal>}</div>;
}

function MasterProjects({user,onToast}){
  const{data,mutate}=useStore();const[modal,setModal]=useState(false);const[filter,setFilter]=useState('all');const[form,setForm]=useState({tenantId:data.tenants[0]?.id||'',name:'',tokenName:'',symbol:'',status:'draft',softCap:'200000',hardCap:'350000',raised:'0',deadline:'2027-03-31',apr:'11',termMonths:'24',city:'CABA',type:'Real Estate',summary:''});
  const list=filter==='all'?data.projects:data.projects.filter(p=>p.tenantId===filter);
  const create=()=>{if(!form.tenantId||!form.name||!form.symbol)return;mutate(d=>{const t=d.tenants.find(x=>x.id===form.tenantId);d.projects.unshift({id:uid('project'),tenantId:form.tenantId,name:form.name,tokenName:form.tokenName||form.name,symbol:form.symbol.toUpperCase(),status:form.status,softCap:Number(form.softCap),hardCap:Number(form.hardCap),raised:Number(form.raised||0),deadline:form.deadline,apr:Number(form.apr),termMonths:Number(form.termMonths),city:form.city,type:form.type,issuerWallet:t?.issuerWallet||'0x...',escrowBalance:Number(form.raised||0),escrowReleased:false,summary:form.summary||'Proyecto de inversión tokenizado creado desde el Master Backoffice.',docs:['Memorando de inversión','Contrato de suscripción'],createdAt:new Date().toISOString()});d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Token creado',detail:`${form.symbol.toUpperCase()} · ${form.name}`,createdAt:new Date().toISOString()})});setModal(false);onToast('Token creado y asignado al tenant seleccionado.');};
  const toggle=(p)=>{mutate(d=>{const x=d.projects.find(q=>q.id===p.id);x.status=x.status==='draft'?'funding':'draft';d.auditLog.unshift({id:uid('a'),actor:user.name,action:x.status==='funding'?'Proyecto publicado':'Proyecto despublicado',detail:x.symbol,createdAt:new Date().toISOString()})});onToast('Estado actualizado.');};
  return <div className="stack-lg"><div className="section-action"><div className="toolbar inline"><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Todas las constructoras</option>{data.tenants.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></div><button className="btn btn-primary" onClick={()=>setModal(true)}><Plus size={16}/> Crear token</button></div><Card><div className="table-wrap"><table><thead><tr><th>Token</th><th>Constructora</th><th>Estado</th><th>Soft cap</th><th>Hard cap</th><th>Colocado</th><th>Deadline</th><th></th></tr></thead><tbody>{list.map(p=>{const t=data.tenants.find(x=>x.id===p.tenantId);return <tr key={p.id}><td><b>{p.symbol}</b><small>{p.name}</small></td><td>{t?.name}</td><td><Badge status={p.status}/></td><td>{money(p.softCap)}</td><td>{money(p.hardCap)}</td><td>{money(p.raised)}</td><td>{dateFmt(p.deadline)}</td><td>{['draft','funding'].includes(p.status)&&<button className="btn btn-small btn-secondary" onClick={()=>toggle(p)}>{p.status==='draft'?'Publicar':'Despublicar'}</button>}</td></tr>})}</tbody></table></div></Card>{modal&&<Modal title="Crear token y proyecto" subtitle="Quedará aislado dentro del tenant seleccionado" onClose={()=>setModal(false)} wide><div className="modal-body form-grid"><div className="field"><label>Constructora</label><select value={form.tenantId} onChange={e=>setForm({...form,tenantId:e.target.value})}>{data.tenants.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></div><div className="field"><label>Estado inicial</label><select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="draft">Borrador</option><option value="funding">Publicado en colocación</option></select></div><div className="field full"><label>Nombre del proyecto</label><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Ej. Torre del Río I"/></div><div className="field"><label>Nombre del token</label><input value={form.tokenName} onChange={e=>setForm({...form,tokenName:e.target.value})} placeholder="Torre del Río I Representación Digital"/></div><div className="field"><label>Símbolo</label><input value={form.symbol} onChange={e=>setForm({...form,symbol:e.target.value})} placeholder="TDRI" maxLength={8}/></div><div className="field"><label>Soft cap</label><input type="number" value={form.softCap} onChange={e=>setForm({...form,softCap:e.target.value})}/></div><div className="field"><label>Hard cap</label><input type="number" value={form.hardCap} onChange={e=>setForm({...form,hardCap:e.target.value})}/></div><div className="field"><label>Deadline</label><input type="date" value={form.deadline} onChange={e=>setForm({...form,deadline:e.target.value})}/></div><div className="field"><label>Retorno objetivo anual</label><div className="input-unit"><input type="number" step="0.1" value={form.apr} onChange={e=>setForm({...form,apr:e.target.value})}/><span>%</span></div></div><div className="field"><label>Plazo</label><div className="input-unit"><input type="number" value={form.termMonths} onChange={e=>setForm({...form,termMonths:e.target.value})}/><span>meses</span></div></div><div className="field"><label>Ubicación</label><input value={form.city} onChange={e=>setForm({...form,city:e.target.value})}/></div><div className="field"><label>Tipo</label><input value={form.type} onChange={e=>setForm({...form,type:e.target.value})}/></div><div className="field full"><label>Descripción corta</label><textarea value={form.summary} onChange={e=>setForm({...form,summary:e.target.value})} rows="3"/></div></div><div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-primary" onClick={create}>Crear token <Coins size={16}/></button></div></Modal>}</div>;
}

function MasterRequests({user,onToast}){
  const{data,mutate}=useStore();const requests=[...data.issuanceRequests].sort((a,b)=>new Date(b.requestedAt)-new Date(a.requestedAt));
  const decide=(r,status)=>{mutate(d=>{const x=d.issuanceRequests.find(q=>q.id===r.id);x.status=status;const tenant=d.tenants.find(t=>t.id===r.tenantId);if(status==='approved'){d.projects.unshift({id:uid('project'),tenantId:r.tenantId,name:r.projectName,tokenName:r.projectName,symbol:r.symbol,status:'draft',softCap:r.softCap,hardCap:r.hardCap,raised:0,deadline:r.deadline,apr:11,termMonths:24,city:'A definir',type:'Real Estate',issuerWallet:tenant?.issuerWallet||'0x...',escrowBalance:0,escrowReleased:false,summary:'Proyecto creado a partir de una solicitud aprobada. Pendiente de completar contenidos antes de publicación.',docs:['Borrador de términos'],createdAt:new Date().toISOString()});}d.auditLog.unshift({id:uid('a'),actor:user.name,action:status==='approved'?'Emisión aprobada':'Emisión rechazada',detail:`${r.symbol} · ${tenant?.name}`,createdAt:new Date().toISOString()})});onToast(status==='approved'?'Solicitud aprobada. Se creó el token en borrador.':'Solicitud rechazada.');};
  return <Card>{requests.length?<div className="request-list master-requests">{requests.map(r=>{const t=data.tenants.find(x=>x.id===r.tenantId);return <div key={r.id}><span className="tenant-avatar" style={{background:t?.brand}}>{t?.name?.[0]}</span><div><b>{r.projectName} · {r.symbol}</b><small>{t?.name} · solicitada {dateFmt(r.requestedAt)}</small></div><div><small>Soft cap</small><b>{money(r.softCap)}</b></div><div><small>Hard cap</small><b>{money(r.hardCap)}</b></div><Badge status={r.status}/>{r.status==='pending'?<div className="button-row"><button className="btn btn-small btn-ghost" onClick={()=>decide(r,'rejected')}>Rechazar</button><button className="btn btn-small btn-primary" onClick={()=>decide(r,'approved')}>Aprobar</button></div>:<span/>}</div>})}</div>:<Empty icon={FileCheck2} title="No hay solicitudes" text="Las solicitudes de las constructoras aparecerán aquí."/>}</Card>;
}

function MasterPeople(){
  const{data}=useStore();const investors=data.users.filter(u=>u.role==='investor');const groups=Object.values(investors.reduce((acc,u)=>{if(!acc[u.globalUserId])acc[u.globalUserId]={id:u.globalUserId,name:u.name,email:u.email,accounts:[]};acc[u.globalUserId].accounts.push(u);return acc},{}));
  return <div className="stack-lg"><div className="info-box"><Fingerprint/><span>El mismo <b>globalUserId</b> agrupa a la persona aunque tenga cuentas en diferentes plataformas o use distintas wallets.</span></div><Card><div className="table-wrap"><table><thead><tr><th>Persona</th><th>Global ID</th><th>Plataformas</th><th>Wallets</th><th>KYC</th><th>Posición global</th></tr></thead><tbody>{groups.map(g=>{const tenants=g.accounts.map(a=>data.tenants.find(t=>t.id===a.tenantId)?.name).filter(Boolean);const wallets=[...new Set(g.accounts.map(a=>a.wallet))];const pos=data.investments.filter(i=>g.accounts.some(a=>a.id===i.userId)).reduce((s,i)=>s+i.tokens,0);return <tr key={g.id}><td><b>{g.name}</b><small>{g.email}</small></td><td><code>{g.id}</code></td><td>{tenants.join(', ')}</td><td>{wallets.map(w=><code key={w}>{w}</code>)}</td><td><Badge status={g.accounts.every(a=>a.kyc==='approved')?'approved':'pending'}/></td><td><b>{money(pos)}</b></td></tr>})}</tbody></table></div></Card></div>;
}

function MasterHoldings(){
  const{data}=useStore();const rows=data.investments.filter(i=>i.tokens>0).map(i=>{const u=data.users.find(x=>x.id===i.userId),p=data.projects.find(x=>x.id===i.projectId),t=data.tenants.find(x=>x.id===p?.tenantId);return{...i,u,p,t}}).filter(x=>x.u&&x.p);
  return <Card><div className="panel-heading"><div><h2>Titularidad consolidada</h2><p>Posiciones activas en todos los tenants.</p></div></div><div className="table-wrap"><table><thead><tr><th>Persona</th><th>Constructora</th><th>Token</th><th>Wallet</th><th>Tenencia</th><th>Estado</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><b>{r.u.name}</b><small>{r.u.globalUserId}</small></td><td>{r.t?.name}</td><td><b>{r.p.symbol}</b><small>{r.p.name}</small></td><td><code>{r.u.wallet}</code></td><td><b>{r.tokens.toLocaleString('es-AR')}</b></td><td><Badge status={r.p.status}/></td></tr>)}</tbody></table></div></Card>;
}


function MasterRegulatory(){
  const{data}=useStore();
  const reportable=data.transactions.filter(t=>t.projectId&&['investment','secondary_buy','secondary_sell','capital','refund'].includes(t.type)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const labels={investment:'Compra primaria',secondary_buy:'Compra secundaria',secondary_sell:'Venta secundaria',capital:'Devolución de capital',refund:'Refund'};
  return <div className="stack-lg"><div className="info-box"><Landmark/><span>Esta pantalla simula la capa de sincronización regulatoria. La integración concreta con Caja de Valores o BYMA queda intencionalmente fuera del mock.</span></div><Card><div className="panel-heading"><div><h2>Eventos reportables</h2><p>Operación → identidad global → actualización de tenencia → reporte.</p></div></div>{reportable.length?<div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Evento</th><th>Titular</th><th>Global ID</th><th>Token</th><th>Plataforma</th><th>Estado demo</th></tr></thead><tbody>{reportable.map(t=>{const u=data.users.find(x=>x.id===t.userId),p=data.projects.find(x=>x.id===t.projectId),tenant=data.tenants.find(x=>x.id===p?.tenantId);return <tr key={t.id}><td>{dateFmt(t.createdAt)}</td><td><b>{labels[t.type]||t.type}</b></td><td>{u?.name}</td><td><code>{u?.globalUserId}</code></td><td><b>{p?.symbol}</b></td><td>{tenant?.name}</td><td><Badge status="approved">Listo para sincronizar</Badge></td></tr>})}</tbody></table></div>:<Empty icon={Landmark} title="Sin eventos" text="Las operaciones que cambian titularidad aparecerán aquí."/>}</Card></div>;
}

function MasterCompliance({user,onToast}){
  const{data,mutate}=useStore();const investors=data.users.filter(u=>u.role==='investor');const initialProject=data.projects[0];const initialEligible=investors.filter(u=>u.tenantId===initialProject?.tenantId);const[transfer,setTransfer]=useState(false);const[form,setForm]=useState({projectId:initialProject?.id||'',fromUserId:initialEligible[0]?.id||'',toUserId:initialEligible[1]?.id||initialEligible[0]?.id||'',amount:'100'});const selectedProject=data.projects.find(p=>p.id===form.projectId);const eligibleInvestors=investors.filter(u=>u.tenantId===selectedProject?.tenantId);
  const freeze=(u)=>{mutate(d=>{const x=d.users.find(q=>q.id===u.id);x.frozen=!x.frozen;d.auditLog.unshift({id:uid('a'),actor:user.name,action:x.frozen?'Usuario congelado':'Usuario descongelado',detail:`${u.name} · ${u.wallet}`,createdAt:new Date().toISOString()})});onToast(u.frozen?'Usuario descongelado.':'Usuario congelado para nuevas operaciones.');};
  const forced=()=>{const n=Number(form.amount);if(n<=0)return;const available=data.investments.filter(i=>i.userId===form.fromUserId&&i.projectId===form.projectId).reduce((sum,i)=>sum+i.tokens,0);if(available<n)return onToast('El usuario origen no tiene suficiente tenencia en ese token.');mutate(d=>{let left=n;d.investments.filter(i=>i.userId===form.fromUserId&&i.projectId===form.projectId&&i.tokens>0).forEach(i=>{if(left<=0)return;const take=Math.min(i.tokens,left);i.tokens-=take;left-=take;});d.investments.push({id:uid('i'),userId:form.toUserId,projectId:form.projectId,tokens:n,invested:0,createdAt:new Date().toISOString()});const p=d.projects.find(x=>x.id===form.projectId),from=d.users.find(x=>x.id===form.fromUserId),to=d.users.find(x=>x.id===form.toUserId);d.auditLog.unshift({id:uid('a'),actor:user.name,action:'Transferencia forzada',detail:`${n} ${p.symbol}: ${from.name} → ${to.name}`,createdAt:new Date().toISOString()})});setTransfer(false);onToast('Transferencia forzada simulada y registrada.');};
  return <div className="stack-lg"><div className="section-action"><div><h2>Usuarios y restricciones</h2><p>Acciones simuladas reservadas a la capa central.</p></div><button className="btn btn-secondary" onClick={()=>setTransfer(true)}><Scale size={16}/> Transferencia forzada</button></div><Card><div className="table-wrap"><table><thead><tr><th>Usuario</th><th>Tenant</th><th>Wallet</th><th>KYC</th><th>AML</th><th>Estado operativo</th><th></th></tr></thead><tbody>{investors.map(u=>{const t=data.tenants.find(x=>x.id===u.tenantId);return <tr key={u.id}><td><b>{u.name}</b><small>{u.email}</small></td><td>{t?.name}</td><td><code>{u.wallet}</code></td><td><Badge status={u.kyc}/></td><td><Badge status={u.aml}/></td><td>{u.frozen?<Badge status="rejected">Congelado</Badge>:<Badge status="approved">Habilitado</Badge>}</td><td><button className={`btn btn-small ${u.frozen?'btn-secondary':'btn-ghost'}`} onClick={()=>freeze(u)}>{u.frozen?'Descongelar':'Congelar'}</button></td></tr>})}</tbody></table></div></Card><div className="warning-box"><ShieldAlert/><span>Estas acciones sólo modifican el mock local. En una implementación real requerirían permisos, controles, trazabilidad y ejecución sobre la infraestructura correspondiente.</span></div>{transfer&&<Modal title="Transferencia forzada" subtitle="Simulación de acción regulatoria" onClose={()=>setTransfer(false)}><div className="modal-body stack-md"><div className="field"><label>Token</label><select value={form.projectId} onChange={e=>{const pid=e.target.value;const p=data.projects.find(x=>x.id===pid);const eligible=investors.filter(u=>u.tenantId===p?.tenantId);setForm({...form,projectId:pid,fromUserId:eligible[0]?.id||'',toUserId:eligible[1]?.id||eligible[0]?.id||''})}}>{data.projects.map(p=><option key={p.id} value={p.id}>{p.symbol} · {p.name}</option>)}</select></div><div className="field"><label>Desde</label><select value={form.fromUserId} onChange={e=>setForm({...form,fromUserId:e.target.value})}>{eligibleInvestors.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></div><div className="field"><label>Hacia</label><select value={form.toUserId} onChange={e=>setForm({...form,toUserId:e.target.value})}>{eligibleInvestors.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></div><div className="field"><label>Cantidad</label><input type="number" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/></div></div><div className="modal-footer"><button className="btn btn-ghost" onClick={()=>setTransfer(false)}>Cancelar</button><button className="btn btn-primary" onClick={forced}>Ejecutar simulación</button></div></Modal>}</div>;
}

function AuditLog({compact=false}){const{data}=useStore();const rows=[...data.auditLog].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));return <div className={`audit-list ${compact?'compact':''}`}>{rows.slice(0,compact?6:100).map(a=><div key={a.id}><span className="audit-dot"/><div><b>{a.action}</b><small>{a.detail}</small></div><div><b>{a.actor}</b><small>{dateFmt(a.createdAt)}</small></div></div>)}</div>}

export default App;
