import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { labApi } from '../../api/labApi.js';
import { EmptyState, LoadingRows, Notice, PageTitle, Panel } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

const emptyResult = { componentId: '', resultType: 'numeric', numericValue: '', textValue: '', unit: '', minimum: '', maximum: '', notes: '' };
const resultKey = () => crypto.randomUUID();

function FormField({ label, ...props }) {
  return <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{label}</span><input {...props} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /></label>;
}
function TextAreaField({ label, ...props }) {
  return <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{label}</span><textarea {...props} className="min-h-24 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /></label>;
}
function ResultCard({ result, t, dateFormat }) {
  const flagStyle = result.flag === 'high' ? 'bg-rose-50 text-rose-800' : result.flag === 'low' ? 'bg-amber-50 text-amber-800' : result.flag === 'normal' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700';
  const range = result.referenceRange ? `${result.referenceRange.minimum ?? '—'} – ${result.referenceRange.maximum ?? '—'}${result.unit ? ` ${result.unit}` : ''}` : null;
  return <article className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold text-slate-900">{result.componentName || result.componentId}</p><p className="mt-1 text-sm text-slate-700">{result.resultType === 'numeric' ? result.numericValue : result.textValue}{result.unit ? ` ${result.unit}` : ''}</p>{range && <p className="mt-1 text-xs text-slate-500">{t.referenceRange}: {range}</p>}</div><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${flagStyle}`}>{t[`flag_${result.flag}`] || result.flag}</span></div>{result.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{result.notes}</p>}<p className="mt-2 text-xs text-slate-400">{dateFormat.format(new Date(result.resultedAt))}</p></article>;
}

export default function LabOrderPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const [order, setOrder] = useState(null);
  const [results, setResults] = useState([]);
  const [resultForm, setResultForm] = useState(emptyResult);
  const [pendingResult, setPendingResult] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [pendingRejection, setPendingRejection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setOrder((await labApi.order(orderId)).data.data); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const components = useMemo(() => order?.components?.length ? order.components : [{ componentId: 'default', name: order?.testName || '' }], [order]);
  const canResult = order && ['pending', 'sample_collected', 'processing'].includes(order.status);
  const canReject = order && ['pending', 'sample_collected', 'processing'].includes(order.status);
  const isMulti = Boolean(order?.components?.length);
  const dateFormat = new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const submitResult = async (event) => {
    event.preventDefault(); setBusy(true); setActionError(null); setRefreshError(null); setSuccess('');
    const numeric = resultForm.resultType === 'numeric';
    let payload = pendingResult;
    if (!payload) {
      payload = {
        componentId: resultForm.componentId || 'default',
        resultType: resultForm.resultType,
        ...(numeric ? { numericValue: Number(resultForm.numericValue) } : { textValue: resultForm.textValue }),
        ...(resultForm.unit.trim() ? { unit: resultForm.unit.trim() } : {}),
        ...(numeric && (resultForm.minimum !== '' || resultForm.maximum !== '') ? { referenceRange: {
          ...(resultForm.minimum !== '' ? { minimum: Number(resultForm.minimum) } : {}),
          ...(resultForm.maximum !== '' ? { maximum: Number(resultForm.maximum) } : {})
        } } : {}),
        ...(resultForm.notes.trim() ? { notes: resultForm.notes.trim() } : {}),
        idempotencyKey: resultKey()
      };
      setPendingResult(payload);
    }
    try {
      const response = await labApi.recordResult(orderId, payload);
      const data = response.data.data;
      setResults((current) => [data.result, ...current.filter((item) => item.id !== data.result.id)]);
      setPendingResult(null); setResultForm({ ...emptyResult, componentId: isMulti ? resultForm.componentId : '' });
      setSuccess(t.resultSaved);
      try { setOrder((await labApi.order(orderId)).data.data); }
      catch (e) { setRefreshError(e); }
    } catch (e) {
      setActionError(e);
      if (!e.apiError?.partialSuccess) setPendingResult(null);
    } finally { setBusy(false); }
  };

  const submitRejection = async (event) => {
    event.preventDefault(); setBusy(true); setActionError(null); setRefreshError(null); setSuccess('');
    const reason = pendingRejection || rejectionReason.trim();
    setPendingRejection(reason);
    try {
      const response = await labApi.rejectSample(orderId, { reason });
      const updated = response.data.data;
      setPendingRejection(null); setRejectionReason(''); setSuccess(t.sampleRejected);
      try { setOrder((await labApi.order(orderId)).data.data); }
      catch (e) { setRefreshError(e); setOrder((current) => ({ ...current, status: updated.status, rejectionReason: updated.rejectionReason, technician: updated.technician })); }
    } catch (e) {
      setActionError(e);
      if (!e.apiError?.partialSuccess) setPendingRejection(null);
    } finally { setBusy(false); }
  };

  const backToQueue = () => navigate('/laboratory', { state: { lastLabUpdate: order ? { testName: order.testName, visitNumber: order.encounter.visitNumber, status: order.status } : null } });

  if (loading) return <LoadingRows />;
  if (error) return <><PageTitle title={t.labOrder} action={<Link className="btn-secondary" to="/laboratory">{t.backToQueue}</Link>} /><Notice error={error} onRetry={load} /></>;
  if (!order) return null;

  return <>
    <PageTitle title={t.labOrder} description={order.testName} action={<button type="button" className="btn-secondary" onClick={backToQueue}>{t.backToQueue}</button>} />
    <div className="mb-5 flex flex-wrap items-center gap-2"><span className="rounded-full bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-800">{t[`labStatus_${order.status}`] || order.status}</span><span className={`rounded-full px-3 py-1 text-sm font-semibold ${order.priority === 'emergency' ? 'bg-rose-50 text-rose-800' : order.priority === 'urgent' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>{t[`priority_${order.priority}`] || order.priority}</span>{order.completedAt && <span className="text-sm text-slate-500">{t.completedAt}: {dateFormat.format(new Date(order.completedAt))}</span>}</div>
    <Notice error={refreshError} onRetry={load} />
    {actionError && <div className="mb-4"><Notice error={actionError} />{(pendingResult || pendingRejection) && actionError.apiError?.partialSuccess && <p className="-mt-2 text-xs text-amber-800">{t.partialRetrySame}</p>}</div>}
    {success && <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{success}</p>}
    <div className="grid gap-5 xl:grid-cols-2">
      <Panel title={t.orderAndPatient}>
        <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">{t.test}</dt><dd className="mt-1 font-semibold text-slate-900">{order.testName}</dd></div><div><dt className="text-slate-500">{t.patientMRN}</dt><dd className="mt-1 font-semibold text-slate-900">{order.patient.mrn}</dd></div><div><dt className="text-slate-500">{t.patientName}</dt><dd className="mt-1 text-slate-800">{order.patient.name}</dd></div><div><dt className="text-slate-500">{t.visitNumber}</dt><dd className="mt-1 text-slate-800">{order.encounter.visitNumber}</dd></div><div><dt className="text-slate-500">{t.department}</dt><dd className="mt-1 text-slate-800">{order.encounter.department}</dd></div><div><dt className="text-slate-500">{t.encounterStatus}</dt><dd className="mt-1 text-slate-800">{t[`encounterStatus_${order.encounter.status}`] || order.encounter.status}</dd></div><div><dt className="text-slate-500">{t.orderedAt}</dt><dd className="mt-1 text-slate-800">{dateFormat.format(new Date(order.orderedAt))}</dd></div>{order.instructions && <div className="sm:col-span-2"><dt className="text-slate-500">{t.orderInstructions}</dt><dd className="mt-1 whitespace-pre-wrap text-slate-800">{order.instructions}</dd></div>}</dl>
        {order.rejectionReason && <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><strong>{t.rejectionReason}:</strong> {order.rejectionReason}</p>}
        <div className="mt-5 border-t border-slate-100 pt-4"><h3 className="text-sm font-semibold text-slate-800">{t.testComponents}</h3>{components.length ? <ul className="mt-2 space-y-2">{components.map((component) => <li className="rounded-lg bg-slate-50 px-3 py-2 text-sm" key={component.componentId}><span className="font-medium">{component.name}</span><span className="ml-2 text-xs text-slate-500">{component.componentId}</span></li>)}</ul> : <EmptyState>{t.noComponents}</EmptyState>}</div>
      </Panel>
      <Panel title={t.enterResult}>
        {!canResult ? <EmptyState>{t.orderNotResultable}</EmptyState> : <form onSubmit={submitResult} className="space-y-3">
          {isMulti && <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.component}</span><select required disabled={busy || Boolean(pendingResult)} value={resultForm.componentId} onChange={(e) => setResultForm((current) => ({ ...current, componentId: e.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5"><option value="">{t.selectComponent}</option>{components.map((component) => <option key={component.componentId} value={component.componentId}>{component.name}</option>)}</select></label>}
          <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.resultType}</span><select disabled={busy || Boolean(pendingResult)} value={resultForm.resultType} onChange={(e) => setResultForm((current) => ({ ...current, resultType: e.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5"><option value="numeric">{t.numericResult}</option><option value="text">{t.textResult}</option></select></label>
          {resultForm.resultType === 'numeric' ? <><FormField label={t.numericValue} type="number" step="any" required disabled={busy || Boolean(pendingResult)} value={resultForm.numericValue} onChange={(e) => setResultForm((current) => ({ ...current, numericValue: e.target.value }))} /><div className="grid gap-3 sm:grid-cols-2"><FormField label={t.minimumReference} type="number" step="any" disabled={busy || Boolean(pendingResult)} value={resultForm.minimum} onChange={(e) => setResultForm((current) => ({ ...current, minimum: e.target.value }))} /><FormField label={t.maximumReference} type="number" step="any" disabled={busy || Boolean(pendingResult)} value={resultForm.maximum} onChange={(e) => setResultForm((current) => ({ ...current, maximum: e.target.value }))} /></div><p className="text-xs text-slate-500">{t.rangeFlagInfo}</p></> : <TextAreaField label={t.textValue} required maxLength={2000} disabled={busy || Boolean(pendingResult)} value={resultForm.textValue} onChange={(e) => setResultForm((current) => ({ ...current, textValue: e.target.value }))} />}
          <FormField label={t.unitOptional} maxLength={50} disabled={busy || Boolean(pendingResult)} value={resultForm.unit} onChange={(e) => setResultForm((current) => ({ ...current, unit: e.target.value }))} />
          <TextAreaField label={t.resultNotesOptional} maxLength={2000} disabled={busy || Boolean(pendingResult)} value={resultForm.notes} onChange={(e) => setResultForm((current) => ({ ...current, notes: e.target.value }))} />
          <button disabled={busy} className="btn-primary">{busy ? t.saving : pendingResult ? t.retrySameResult : t.saveResult}</button>
        </form>}
      </Panel>
      {canReject && <Panel title={t.rejectSample}>
        <p className="mb-3 text-sm text-slate-600">{t.rejectionHelp}</p><form onSubmit={submitRejection} className="space-y-3"><TextAreaField label={t.rejectionReason} required minLength={10} maxLength={1000} disabled={busy || Boolean(pendingRejection)} value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} /><button disabled={busy} className="btn-secondary">{busy ? t.saving : pendingRejection ? t.retryRejection : t.rejectSample}</button></form>
      </Panel>}
      <Panel title={t.recordedResults}>
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t.resultHistoryGap}</p>
        {results.length ? <div className="space-y-3">{results.map((result) => <ResultCard key={result.id} result={result} t={t} dateFormat={dateFormat} />)}</div> : <EmptyState>{t.noResultsThisSession}</EmptyState>}
      </Panel>
    </div>
    <div className="mt-5 flex justify-end"><button className="btn-secondary" type="button" onClick={load}>{t.refreshOrderStatus}</button></div>
  </>;
}
