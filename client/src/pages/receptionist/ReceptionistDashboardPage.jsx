import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { receptionApi } from '../../api/receptionApi.js';
import { EmptyState, LoadingRows, Notice, PageTitle, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export default function ReceptionistDashboardPage() {
  const { t, language } = useLanguage(); const location = useLocation(); const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null); const [encounters, setEncounters] = useState(() => location.state?.createdEncounter ? [location.state.createdEncounter] : []);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const response = await receptionApi.patients({ page: 1, limit: 5 }); setData(response.data.data); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  useEffect(() => {
    const receive = (event) => setEncounters((current) => [event.detail, ...current.filter((item) => item.id !== event.detail.id)].slice(0, 5));
    window.addEventListener('hospital-emr:reception-encounter-created', receive);
    return () => window.removeEventListener('hospital-emr:reception-encounter-created', receive);
  }, []);
  const number = new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US');
  return <><PageTitle title={t.receptionistDashboard} description={t.receptionistDashboardDescription} action={<div className="flex flex-wrap gap-2"><Link className="btn-primary" to="/receptionist/register">{t.registerPatient}</Link><Link className="btn-secondary" to="/receptionist/encounters/new">{t.createEncounter}</Link></div>} /><Notice error={error} onRetry={load} /><div className="mb-5 grid gap-4 sm:grid-cols-2"><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.totalRegisteredPatients}</p><p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{loading ? '—' : number.format(data?.pagination?.total ?? 0)}</p><Link className="mt-3 inline-block text-sm font-semibold text-blue-700 hover:underline" to="/receptionist/patients">{t.openDirectory}</Link></div><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.encountersCreatedThisSession}</p><p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{number.format(encounters.length)}</p><p className="mt-2 text-xs text-slate-500">{t.encounterStatsLimit}</p></div></div><div className="grid gap-5 xl:grid-cols-2"><Panel title={t.recentPatientRegistrations} action={<Link className="text-sm font-semibold text-blue-700" to="/receptionist/patients">{t.viewAll}</Link>}>{loading ? <LoadingRows /> : <Table rows={data?.patients || []} empty={t.noPatients} columns={[
      { key: 'mrn', label: t.mrn, render: (row) => <Link className="font-semibold text-blue-700" to={`/receptionist/patients/${row.id}`}>{row.mrn}</Link> },
      { key: 'name', label: t.patientName, render: (row) => `${row.firstName} ${row.fatherName} ${row.grandfatherName}` },
      { key: 'registeredAt', label: t.registered, render: (row) => new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium' }).format(new Date(row.registeredAt)) }
    ]} />}</Panel><Panel title={t.recentEncounterActivity}>{encounters.length === 0 ? <EmptyState>{t.noEncounterActivity}</EmptyState> : <div className="divide-y divide-slate-100">{encounters.map((item) => <div className="flex items-center justify-between gap-2 py-3 first:pt-0 last:pb-0" key={item.id}><div><p className="font-semibold text-slate-800">{item.visitNumber}</p><p className="text-xs text-slate-500">{item.department} · {item.visitType}</p></div><span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800">{t.open}</span></div>)}</div>}<p className="mt-3 text-xs text-slate-500">{t.encounterStatsLimit}</p></Panel></div><p className="mt-5 text-xs text-slate-500">{t.identityOnlyNotice}</p>
  </>;
}
