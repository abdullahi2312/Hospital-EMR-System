import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, responseData } from '../../api/adminApi.js';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { EmptyState, LoadingRows, Notice, PageTitle, Panel } from '../../components/AdminUi.jsx';

function dateDefault(offset) { const date = new Date(); date.setDate(date.getDate() + offset); return date.toISOString().slice(0, 10); }

export default function AdminDashboardPage() {
  const { t, language } = useLanguage();
  const [range, setRange] = useState({ from: dateDefault(-29), to: dateDefault(0) });
  const [draftRange, setDraftRange] = useState({ from: dateDefault(-29), to: dateDefault(0) });
  const [analytics, setAnalytics] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [summary, logs] = await Promise.all([adminApi.analytics(range), adminApi.auditLogs({ page: 1, limit: 6 })]);
      setAnalytics(responseData(summary)); setActivity(responseData(logs)?.logs || []);
    } catch (requestError) { setError(requestError); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  const number = (value) => new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US').format(value ?? 0);
  const metric = (label, value, note) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{loading ? '—' : number(value)}</p>{note && <p className="mt-1 text-xs text-slate-500">{note}</p>}</div>;
  const metrics = analytics ? [
    [t.patientsRegistered, analytics.patients?.registrations], [t.encounters, analytics.encounters?.total],
    [t.labOrders, analytics.laboratory?.orders?.total], [t.labResults, analytics.laboratory?.results?.total],
    [t.prescriptions, analytics.prescriptions?.total], [t.referrals, analytics.referrals?.total],
    [t.inventoryUnits, analytics.pharmacy?.inventory?.unitsOnHand, t.inventoryLots.replace('{count}', number(analytics.pharmacy?.inventory?.lots))],
    [t.dispenses, analytics.pharmacy?.dispensing?.transactions, t.unitsDispensed.replace('{count}', number(analytics.pharmacy?.dispensing?.units))]
  ] : [];
  return <>
    <PageTitle title={t.adminDashboard} description={t.adminDashboardDescription} action={<Link className="btn-primary" to="/admin/users/new">{t.createUser}</Link>} />
    <Notice error={error} onRetry={load} />
    <Panel title={t.reportingPeriod} className="mb-5"><form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setRange(draftRange); }}><label className="space-y-1 text-xs font-semibold text-slate-500"><span>{t.fromDate}</span><input className="form-input block" type="date" value={draftRange.from} max={draftRange.to} onChange={(event) => setDraftRange((current) => ({ ...current, from: event.target.value }))} /></label><label className="space-y-1 text-xs font-semibold text-slate-500"><span>{t.toDate}</span><input className="form-input block" type="date" value={draftRange.to} min={draftRange.from} max={dateDefault(0)} onChange={(event) => setDraftRange((current) => ({ ...current, to: event.target.value }))} /></label><button className="btn-secondary" type="submit">{t.applyFilters}</button><span className="text-xs text-slate-500">{t.analyticsRangeHint}</span></form></Panel>
    {loading && !analytics ? <LoadingRows /> : analytics ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, note]) => metric(label, value, note))}</div> : <Panel title={t.analytics}><EmptyState>{t.unavailable}</EmptyState></Panel>}
    {analytics && <div className="mt-5 grid gap-5 lg:grid-cols-2"><Panel title={t.paymentSummary}><div className="space-y-4">{Object.entries(analytics.payments?.currencies || {}).length === 0 ? <EmptyState>{t.noPaymentActivity}</EmptyState> : Object.entries(analytics.payments.currencies).map(([currency, values]) => <div className="flex items-center justify-between border-b border-slate-100 pb-3 last:border-0" key={currency}><div><p className="font-semibold text-slate-800">{currency}</p><p className="text-xs text-slate-500">{number(values.totalCount)} {t.transactions}</p></div><p className="text-lg font-bold text-slate-900">{number(values.totalAmount)} <span className="text-sm font-medium text-slate-500">{currency}</span></p></div>)}</div><p className="mt-3 text-xs text-slate-500">{t.simulatedPaymentsOnly}</p></Panel>
      <Panel title={t.inventoryStatus}><div className="grid grid-cols-3 gap-3 text-center">{[[t.lowStock, analytics.pharmacy.inventory.lowStockLots], [t.expired, analytics.pharmacy.inventory.expiredLots], [t.expiringSoon, analytics.pharmacy.inventory.expiringWithin30Days]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><p className="text-xl font-bold text-slate-900">{number(value)}</p><p className="mt-1 text-xs text-slate-500">{label}</p></div>)}</div></Panel></div>}
    <Panel title={t.recentActivity} action={<Link to="/admin/audit-logs" className="text-sm font-semibold text-blue-700">{t.viewAll}</Link>} className="mt-5">{loading && activity.length === 0 ? <LoadingRows /> : activity.length === 0 ? <EmptyState>{t.noActivity}</EmptyState> : <div className="divide-y divide-slate-100">{activity.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"><div><p className="text-sm font-medium text-slate-800">{item.action.replaceAll('_', ' ')}</p><p className="mt-1 text-xs text-slate-500">{item.entityType} · {t.actor}: {item.actorId}</p></div><time className="text-xs text-slate-500">{new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</time></div>)}</div>}</Panel>
  </>;
}
