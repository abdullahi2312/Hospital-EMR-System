import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { homeForRole, ROLE_LABEL } from '../utils/roles.js';
import LanguageToggle from '../components/LanguageToggle.jsx';

const roleNavigation = {
  admin: [
    { labelKey: 'dashboard', path: '/admin' },
    { labelKey: 'userManagement', path: '/admin/users' },
    { labelKey: 'patientDirectory', path: '/admin/patients' },
    { labelKey: 'departmentManagement', path: '/admin/departments' },
    { labelKey: 'auditLogs', path: '/admin/audit-logs' }
  ],
  receptionist: [
    { labelKey: 'dashboard', path: '/receptionist' },
    { labelKey: 'patientDirectory', path: '/receptionist/patients' },
    { labelKey: 'patientRegistration', path: '/receptionist/register' },
    { labelKey: 'encounterCheckIn', path: '/receptionist/encounters/new' }
  ],
  doctor: [{ labelKey: 'dashboard', path: '/doctor' }],
  lab_technician: [{ labelKey: 'labDashboard', path: '/laboratory' }],
  pharmacist: [{ labelKey: 'pharmacyDashboard', path: '/pharmacy' }],
  patient: [
    { labelEn: 'Dashboard', labelSo: 'Bogga guud', path: '/patient' },
    { labelEn: 'Visits', labelSo: 'Booqashooyinka', path: '/patient/visits' },
    { labelEn: 'Lab results', labelSo: 'Natiijooyinka shaybaarka', path: '/patient/lab-results' },
    { labelEn: 'Prescriptions', labelSo: 'Daawo-qorisyada', path: '/patient/prescriptions' },
    { labelEn: 'Care access', labelSo: 'Gelitaanka daryeelka', path: '/patient/consents' }
  ]
};

function Navigation({ role, onNavigate }) {
  const items = roleNavigation[role] || [];
  const { t, language } = useLanguage();
  return (
    <nav className="space-y-1" aria-label="Main navigation">
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          onClick={onNavigate}
          end
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${isActive ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
        >
          <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
          {item.labelKey ? t[item.labelKey] : language === 'so' ? item.labelSo : item.labelEn}
        </NavLink>
      ))}
    </nav>
  );
}

function Sidebar({ role, mobileOpen, onClose }) {
  const { t, language } = useLanguage();
  const roleTitle = role === 'patient' ? (language === 'so' ? 'Bukaan' : 'Patient') : ROLE_LABEL[role];
  return (
    <>
      {mobileOpen && <button className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" aria-label="Close navigation" onClick={onClose} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[270px] flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:z-auto lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[72px] items-center border-b border-slate-100 px-5">
          <Link to={homeForRole(role)} onClick={onClose} className="flex items-center gap-3 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600">
            <span className="grid size-9 place-items-center rounded-xl bg-blue-800 text-sm font-bold text-white" aria-hidden="true">H</span>
            <span>
              <span className="block text-sm font-bold tracking-tight text-slate-900">{t.appName}</span>
              <span className="mt-0.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">Care workspace</span>
            </span>
          </Link>
        </div>
        <div className="px-4 py-5">
          <p className="mb-2 px-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">{t.workspace}</p>
          <Navigation role={role} onNavigate={onClose} />
        </div>
        <div className="mt-auto border-t border-slate-100 p-4">
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-800">{roleTitle}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Access follows your account permissions.</p>
          </div>
        </div>
      </aside>
    </>
  );
}

export default function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const { t, language } = useLanguage();
  const role = user?.role;
  const roleTitle = role === 'patient' ? (language === 'so' ? 'Bukaan' : 'Patient') : ROLE_LABEL[role];

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <Sidebar role={role} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="grid size-10 shrink-0 place-items-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-600 lg:hidden"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <span className="text-lg leading-none" aria-hidden="true">☰</span>
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{roleTitle}</p>
              <p className="hidden truncate text-xs text-slate-500 sm:block">{user?.fullName || user?.username}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <LanguageToggle />
            <div className="hidden h-8 w-px bg-slate-200 sm:block" />
            <span className="hidden max-w-36 truncate text-sm font-medium text-slate-700 md:block">{user?.fullName || user?.username}</span>
            <button type="button" onClick={logout} className="rounded-lg px-2.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 sm:px-3">
              {t.signOut}
            </button>
          </div>
        </header>
        <main className="w-full flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          <div className="mx-auto w-full max-w-7xl"><Outlet /></div>
        </main>
        <footer className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-400 sm:px-6 lg:px-8">
          Hospital EMR · Authorized access only
        </footer>
      </div>
    </div>
  );
}
