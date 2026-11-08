import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { labApi } from '../../api/labApi.js';
import { EmptyState, LoadingRows, Notice, PageTitle, Panel, Table } from '../../components/AdminUi.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export default function LabDashboardPage() {
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const location = useLocation();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = location.state?.lastLabUpdate;

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try { setOrders((await labApi.pendingOrders({ limit: 100 })).data.data.orders || []); }
    catch (e) { setError(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { Promise.resolve().then(() => load()); }, [load]);

  const activeId = String(user?.id || user?._id || '');
  const mine = useMemo(() => orders.filter((order) => order.technician && String(order.technician) === activeId), [orders, activeId]);
  const unclaimed = useMemo(() => orders.filter((order) => !order.technician), [orders]);
  const dateFormat = new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });

  return <>
    <PageTitle title={t.labDashboard} description={t.labDashboardDescription} action={<button type="button" className="btn-secondary" onClick={() => load(true)} disabled={refreshing}>{refreshing ? t.refreshing : t.refreshQueue}</button>} />
    <Notice error={error} onRetry={() => load()} />
    <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.unclaimedOrders}</p><p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{loading ? '—' : new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US').format(unclaimed.length)}</p><p className="mt-2 text-xs text-slate-500">{t.queueScope}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.assignedToYou}</p><p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{loading ? '—' : new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US').format(mine.length)}</p><p className="mt-2 text-xs text-slate-500">{t.workingOrdersHint}</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{t.mostRecentLabUpdate}</p>{latest ? <><p className="mt-2 text-lg font-bold text-slate-900">{t[`labStatus_${latest.status}`] || latest.status}</p><p className="mt-1 text-sm text-slate-600">{latest.testName} · {latest.visitNumber}</p></> : <p className="mt-2 text-sm text-slate-500">{t.noSessionLabUpdates}</p>}<p className="mt-2 text-xs text-slate-500">{t.completedHistoryGap}</p></div>
    </div>
    <Panel title={t.labQueue}>
      {loading ? <LoadingRows /> : <Table rows={orders} empty={t.noPendingLabOrders} columns={[
        { key: 'testName', label: t.test, render: (order) => <Link className="font-semibold text-blue-700 hover:underline" to={`/laboratory/orders/${order.id}`}>{order.testName}</Link> },
        { key: 'patient', label: t.patientIdentifier, render: (order) => <span><span className="block font-medium text-slate-800">{order.patient.mrn}</span><span className="text-xs text-slate-500">{order.patient.name}</span></span> },
        { key: 'encounter', label: t.visitNumber, render: (order) => order.encounter.visitNumber },
        { key: 'priority', label: t.priority, render: (order) => <span className={order.priority === 'emergency' ? 'font-semibold text-rose-700' : order.priority === 'urgent' ? 'font-semibold text-amber-700' : ''}>{t[`priority_${order.priority}`] || order.priority}</span> },
        { key: 'status', label: t.status, render: (order) => <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800">{order.technician ? t.labWorking : t.labStatus_pending}</span> },
        { key: 'orderedAt', label: t.orderedAt, render: (order) => dateFormat.format(new Date(order.orderedAt)) },
        { key: 'open', label: t.openOrder, render: (order) => <Link className="btn-secondary" to={`/laboratory/orders/${order.id}`}>{t.openOrder}</Link> }
      ]} />}
      {!loading && orders.length >= 100 && <p className="mt-3 text-xs text-slate-500">{t.queueLimitNote}</p>}
    </Panel>
    <p className="mt-4 text-xs text-slate-500">{t.labPrivacyNote}</p>
  </>;
}
