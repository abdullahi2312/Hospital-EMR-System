import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { homeForRole } from '../utils/roles.js';
import { normalizeApiError } from '../api/apiErrors.js';
import LanguageToggle from '../components/LanguageToggle.jsx';

export default function LoginPage() {
  const { login, user, isAuthenticated, loading } = useAuth();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [mrn, setMrn] = useState('');
  const [phone, setPhone] = useState('');
  const [patientMode, setPatientMode] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (loading) return <div className="min-h-screen bg-slate-50" />;
  if (isAuthenticated) return <Navigate to={homeForRole(user?.role)} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const user = await login(patientMode ? { mrn, phone, password } : { username, password }, patientMode);
      navigate(location.state?.from?.pathname || homeForRole(user.role), { replace: true });
    } catch (requestError) {
      const apiError = requestError.apiError || normalizeApiError(requestError);
      setError(apiError.status === 429 ? `${apiError.message} (${apiError.retryAfter || ''}s)` : apiError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(430px,0.8fr)]">
      <section className="relative hidden overflow-hidden bg-[#102a43] px-12 py-14 text-white lg:flex lg:flex-col lg:justify-between xl:px-20">
        <div className="absolute -right-32 -top-32 size-[520px] rounded-full border border-white/10" aria-hidden="true" />
        <div className="absolute -right-16 -top-16 size-[390px] rounded-full border border-white/10" aria-hidden="true" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-white text-lg font-bold text-blue-900" aria-hidden="true">H</span>
          <span className="text-lg font-semibold tracking-tight">Hospital EMR</span>
        </div>
        <div className="relative max-w-xl pb-12">
          <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-blue-200">Clinical workspace</p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">Connected care, built around your team.</h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-blue-100/80">A secure workspace for authorized hospital staff and patients.</p>
        </div>
        <p className="relative text-xs text-blue-100/60">Authorized access only · Session activity is subject to audit</p>
      </section>

      <section className="flex min-h-screen flex-col px-5 py-6 sm:px-8 lg:px-12">
        <div className="flex items-center justify-between lg:justify-end">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="grid size-9 place-items-center rounded-lg bg-blue-800 text-sm font-bold text-white" aria-hidden="true">H</span>
            <span className="text-sm font-bold text-slate-900">{t.appName}</span>
          </div>
          <LanguageToggle />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[420px]">
            <p className="text-sm font-semibold text-blue-800">{language === 'so' ? 'Gelitaan ammaan ah' : 'Secure sign in'}</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">{t.signIn}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{patientMode ? (language === 'so' ? 'Ku gal MRN-kaaga, telefoonkaaga iyo erayga sirta ah.' : 'Sign in with your MRN, phone number, and password.') : (language === 'so' ? 'Geli xogta akoonka isbitaalka.' : 'Enter your hospital account credentials to continue.')}</p>

            <div className="mt-5 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm">
              <button type="button" onClick={() => { setPatientMode(false); setError(''); }} className={`rounded-md px-3 py-2 font-semibold ${!patientMode ? 'bg-white text-blue-800 shadow-sm' : 'text-slate-600'}`}>{language === 'so' ? 'Shaqaale' : 'Staff'}</button>
              <button type="button" onClick={() => { setPatientMode(true); setError(''); }} className={`rounded-md px-3 py-2 font-semibold ${patientMode ? 'bg-white text-blue-800 shadow-sm' : 'text-slate-600'}`}>{language === 'so' ? 'Bukaan' : 'Patient'}</button>
            </div>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              {patientMode ? <>
                <div><label htmlFor="mrn" className="mb-1.5 block text-sm font-semibold text-slate-700">MRN</label><input id="mrn" name="mrn" autoComplete="username" required value={mrn} onChange={(event) => setMrn(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-700 focus:ring-4 focus:ring-blue-100" placeholder="MRN-000001" /></div>
                <div><label htmlFor="phone" className="mb-1.5 block text-sm font-semibold text-slate-700">{language === 'so' ? 'Telefoon' : 'Phone number'}</label><input id="phone" name="phone" type="tel" autoComplete="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-700 focus:ring-4 focus:ring-blue-100" /></div>
              </> : <div>
                <label htmlFor="username" className="mb-1.5 block text-sm font-semibold text-slate-700">{t.username}</label>
                <input id="username" name="username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-700 focus:ring-4 focus:ring-blue-100" placeholder="Enter your username" />
              </div>}
              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-slate-700">{t.password}</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-700 focus:ring-4 focus:ring-blue-100"
                  placeholder="Enter your password"
                />
              </div>
              {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800" role="alert">{error}</div>}
              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-800 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-900 focus:outline-none focus:ring-4 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <span className="size-4 animate-spin rounded-full border-2 border-white/50 border-t-white" aria-hidden="true" />}
                {submitting ? 'Signing in…' : t.signIn}
              </button>
            </form>
            <p className="mt-8 text-center text-xs leading-5 text-slate-400">If you cannot access your account, contact your system administrator.</p>
          </div>
        </div>
        <p className="text-center text-xs text-slate-400">© Hospital EMR · Private and confidential</p>
      </section>
    </div>
  );
}
