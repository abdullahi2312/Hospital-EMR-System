import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, responseData } from '../../api/adminApi.js';
import { Field, LoadingRows, Notice, PageTitle, Pagination, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export function AuditLogsPage({ access = false }) {
  const { t, language } = useLanguage(); const [page, setPage] = useState(1); const [fromDate, setFromDate] = useState(''); const [toDate, setToDate] = useState(''); const [dates, setDates] = useState({}); const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const params = { page, limit: 20, ...(dates.fromDate ? { fromDate: dates.fromDate } : {}), ...(dates.toDate ? { toDate: dates.toDate } : {}) }; setData(responseData(await (access ? adminApi.accessLogs(params) : adminApi.auditLogs(params)))); } catch (e) { setError(e); } finally { setLoading(false); } }, [access, dates, page]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  const columns = access ? [
    { key: 'action', label: t.action, render: (row) => row.action.replaceAll('_', ' ') },
    { key: 'accessMethod', label: t.accessMethod, render: (row) => row.accessMethod.replaceAll('_', ' ') },
    { key: 'user', label: t.actor, render: (row) => row.user },
    { key: 'accessedAt', label: t.time, render: (row) => new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.accessedAt)) }
  ] : [
    { key: 'action', label: t.action, render: (row) => row.action.replaceAll('_', ' ') },
    { key: 'entityType', label: t.entityType },
    { key: 'actorId', label: t.actor },
    { key: 'createdAt', label: t.time, render: (row) => new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.createdAt)) }
  ];
  function submit(event) { event.preventDefault(); setPage(1); setDates({ fromDate, toDate }); }
  return <><PageTitle title={access ? t.accessLogs : t.auditLogs} description={access ? t.accessLogsDescription : t.auditLogsDescription} action={<div className="flex gap-2"><Link className={`btn-secondary ${!access ? 'border-blue-300 text-blue-800' : ''}`} to="/admin/audit-logs">{t.auditLogs}</Link><Link className={`btn-secondary ${access ? 'border-blue-300 text-blue-800' : ''}`} to="/admin/access-logs">{t.accessLogs}</Link></div>} /><Notice error={error} onRetry={load} /><Panel title={access ? t.accessHistory : t.auditHistory}><form onSubmit={submit} className="mb-5 flex flex-wrap items-end gap-3"><Field label={t.fromDate} type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} /><Field label={t.toDate} type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} /><button className="btn-secondary" type="submit">{t.applyFilters}</button><span className="basis-full text-xs text-slate-500">{t.logPrivacyNotice}</span></form>{loading ? <LoadingRows /> : <Table rows={access ? data?.logs || [] : data?.logs || []} columns={columns} empty={t.noLogs} />}<Pagination value={data?.pagination} onChange={setPage} /></Panel></>;
}
