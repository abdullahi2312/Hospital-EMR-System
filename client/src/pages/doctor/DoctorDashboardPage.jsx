import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { doctorApi } from '../../api/doctorApi.js';
import { EmptyState, LoadingRows, Notice, PageTitle, Pagination, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export default function DoctorDashboardPage() {
  const { t, language } = useLanguage();
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [patientId, setPatientId] = useState('');
  const [patientTimeline, setPatientTimeline] = useState(null);
  const [patientAccessError, setPatientAccessError] = useState(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState('');
  const [breakGlass, setBreakGlass] = useState(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setResult((await doctorApi.encounters({ page, limit: 20 })).data.data); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [page]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);
  const rows = result?.encounters || [];
  const dateFormat = new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const accessTimeline = async (event) => {
    event.preventDefault(); setAccessLoading(true); setPatientAccessError(null); setPatientTimeline(null); setBreakGlass(null);
    try { setPatientTimeline((await doctorApi.timeline(patientId.trim(), { page: 1, limit: 20 })).data.data); }
    catch (e) { setPatientAccessError(e); }
    finally { setAccessLoading(false); }
  };
  const activateBreakGlass = async (event) => {
    event.preventDefault();
    if (!window.confirm(t.breakGlassConfirm)) return;
    setAccessLoading(true); setPatientAccessError(null); setBreakGlass(null);
    try {
      const result = (await doctorApi.breakGlass(patientId.trim(), { reason: emergencyReason })).data.data;
      setBreakGlass(result); setEmergencyReason('');
    } catch (e) { setPatientAccessError(e); }
    finally { setAccessLoading(false); }
  };
  return <>
    <PageTitle title={t.doctorDashboard} description={t.doctorDashboardDescription} />
    <Notice error={error} onRetry={load} />
    <div className="mb-5 grid gap-4 sm:grid-cols-2">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.assignedEncounters}</p><p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{loading ? '—' : new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US').format(result?.pagination?.total || 0)}</p><p className="mt-2 text-xs text-slate-500">{t.assignedOnlyNotice}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.recentActivity}</p><p className="mt-2 text-sm leading-6 text-slate-600">{t.doctorActivityDescription}</p></div>
    </div>
    <Panel title={t.assignedEncounters}>
      {loading ? <LoadingRows /> : rows.length === 0 ? <EmptyState>{t.noAssignedEncounters}</EmptyState> : <Table rows={rows} columns={[
        { key: 'visitNumber', label: t.visitNumber, render: (row) => <Link className="font-semibold text-blue-700 hover:underline" to={`/doctor/encounters/${row.id}`}>{row.visitNumber}</Link> },
        { key: 'department', label: t.department },
        { key: 'visitType', label: t.visitType, render: (row) => t[row.visitType] || row.visitType },
        { key: 'status', label: t.status, render: (row) => t[row.status] || row.status },
        { key: 'openedAt', label: t.opened, render: (row) => dateFormat.format(new Date(row.openedAt)) },
        { key: 'open', label: t.open, render: (row) => <Link className="btn-secondary" to={`/doctor/encounters/${row.id}`}>{t.open}</Link> }
      ]} />}
      <Pagination value={result?.pagination} onChange={setPage} />
    </Panel>
    <Panel title={t.patientRecordAccess} className="mt-5">
      <p className="mb-3 text-sm text-slate-600">{t.knownPatientIdNotice}</p>
      <form onSubmit={accessTimeline} className="mb-4 flex flex-col gap-3 sm:flex-row"><input aria-label={t.patientId} required minLength={24} maxLength={24} pattern="[a-fA-F0-9]{24}" value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder={t.patientIdPlaceholder} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /><button disabled={accessLoading} className="btn-primary">{accessLoading ? t.loadingData : t.viewAuthorizedTimeline}</button></form>
      <Notice error={patientAccessError} />
      {patientTimeline && <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3"><p className="text-sm font-semibold text-slate-800">{t.authorizedTimelineEvents}</p>{patientTimeline.events?.length ? <ul className="mt-2 space-y-2">{patientTimeline.events.map((event) => <li key={`${event.type}-${event.id}`} className="text-sm text-slate-700"><span className="font-medium">{dateFormat.format(new Date(event.date))} · {t[event.type] || event.type}</span>{event.type === 'diagnosis' ? ` · ${event.details.code || ''} ${event.details.description}` : event.type === 'encounter' ? ` · ${event.details.department} · ${event.details.status}` : ''}</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">{t.noTimeline}</p>}</div>}
      <form onSubmit={activateBreakGlass} className="space-y-3 border-t border-slate-200 pt-4"><p className="text-sm font-medium text-slate-800">{t.breakGlass}</p><p className="text-xs text-slate-500">{t.breakGlassNotice}</p><label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.emergencyReason}</span><textarea required minLength={20} maxLength={2000} value={emergencyReason} onChange={(e) => setEmergencyReason(e.target.value)} className="min-h-20 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /></label><button disabled={accessLoading || !patientId} className="btn-secondary">{t.activateBreakGlass}</button></form>
      {breakGlass && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{t.breakGlassExpires}: {dateFormat.format(new Date(breakGlass.expiresAt))}</p>}
    </Panel>
  </>;
}
