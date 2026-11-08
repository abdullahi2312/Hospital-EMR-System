import { useAuth } from '../context/AuthContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { ROLE_LABEL } from '../utils/roles.js';

export default function DashboardPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const roleLabel = ROLE_LABEL[user?.role] || 'Workspace';

  return (
    <div>
      <div className="mb-6">
        <p className="text-sm font-semibold text-blue-800">{roleLabel} workspace</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{t.welcome}, {user?.fullName || user?.username}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{t.roleDescription[user?.role]}</p>
      </div>
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" aria-labelledby="workspace-heading">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-800" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="size-5" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
              <path strokeLinecap="round" d="M8 7h8M8 11h6" />
            </svg>
          </span>
          <div>
            <h2 id="workspace-heading" className="text-base font-semibold text-slate-900">Your workspace is ready</h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-500">This foundation is connected to your authenticated account. Role-specific work areas will be added in the next implementation phase.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
