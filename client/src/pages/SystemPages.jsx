import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { homeForRole } from '../utils/roles.js';

export function UnauthorizedPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-7 text-center shadow-sm sm:p-10">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-800">403</p>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">Access unavailable</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">{t.unauthorized}</p>
      {user && <Link className="mt-6 inline-flex rounded-lg bg-blue-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-900" to={homeForRole(user.role)}>Return to your workspace</Link>}
    </div>
  );
}

export function NotFoundPage() {
  const { t } = useLanguage();
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-7 text-center shadow-sm sm:p-10">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">404</p>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">{t.notFound}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">The address may be incorrect or the page may have moved.</p>
      <Link className="mt-6 inline-flex rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50" to="/">Go to workspace</Link>
    </div>
  );
}
