import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doctorApi } from '../../api/doctorApi.js';
import { EmptyState, LoadingRows, Notice, PageTitle, Panel } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

const initialNotes = { clinicalNotes: '', examinationFindings: '', assessment: '', treatmentPlan: '', followUpInstructions: '' };
const key = () => crypto.randomUUID();

function Field({ label, ...props }) {
  return <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{label}</span><input {...props} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /></label>;
}
function Textarea({ label, ...props }) {
  return <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{label}</span><textarea {...props} className="min-h-24 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /></label>;
}
function ActionMessage({ value, error }) {
  if (error) return <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error?.apiError?.message || error?.response?.data?.message || 'Request failed.'}</p>;
  return value ? <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{value}</p> : null;
}

export default function DoctorEncounterPage() {
  const { id } = useParams();
  const { t, language } = useLanguage();
  const [encounter, setEncounter] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [vitals, setVitals] = useState([]);
  const [diagnoses, setDiagnoses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [dirtyNotes, setDirtyNotes] = useState({});
  const [vitalForm, setVitalForm] = useState({ systolic: '', diastolic: '', temperature: '', pulse: '', respiratoryRate: '', weight: '', height: '', oxygenSaturation: '' });
  const [diagnosisForm, setDiagnosisForm] = useState({ code: '', description: '', isPrimary: false });
  const [prescriptionForm, setPrescriptionForm] = useState({ medicationId: '', dose: '', route: 'oral', frequency: '', duration: '', quantity: '', instructions: '', overrideAllergyWarning: false, allergyOverrideReason: '' });
  const [breakGlassReason, setBreakGlassReason] = useState('');
  const [breakGlassResult, setBreakGlassResult] = useState(null);
  const [resourceErrors, setResourceErrors] = useState({});
  const requestKeys = useRef({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const encounterResponse = await doctorApi.encounter(id);
      const data = encounterResponse.data.data;
      setEncounter(data);
      setNotes(Object.fromEntries(Object.keys(initialNotes).map((field) => [field, data[field] || ''])));
      setDirtyNotes({});
      const outcomes = await Promise.allSettled([
        doctorApi.timeline(data.patient, { page: 1, limit: 20 }),
        doctorApi.vitals(id),
        doctorApi.diagnoses(id)
      ]);
      setTimeline(outcomes[0].status === 'fulfilled' ? outcomes[0].value.data.data : { error: outcomes[0].reason });
      setVitals(outcomes[1].status === 'fulfilled' ? outcomes[1].value.data.data.vitals || [] : []);
      setDiagnoses(outcomes[2].status === 'fulfilled' ? outcomes[2].value.data.data.diagnoses || [] : []);
      setResourceErrors({
        vitals: outcomes[1].status === 'rejected' ? outcomes[1].reason : null,
        diagnoses: outcomes[2].status === 'rejected' ? outcomes[2].reason : null
      });
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const perform = async (request, onSuccess, successMessage, operation) => {
    setBusy(true); setActionError(null); setSuccess('');
    try { const response = await request(); onSuccess?.(response.data.data); setSuccess(successMessage); if (operation) delete requestKeys.current[operation]; return response.data.data; }
    catch (e) { setActionError(e); if (operation && !e.apiError?.partialSuccess) delete requestKeys.current[operation]; return null; }
    finally { setBusy(false); }
  };
  const loadMoreTimeline = async () => {
    if (!timeline?.pagination?.hasMore || timelineLoadingMore) return;
    setTimelineLoadingMore(true);
    try {
      const nextPage = timeline.pagination.page + 1;
      const response = await doctorApi.timeline(encounter.patient, { page: nextPage, limit: timeline.pagination.limit });
      const next = response.data.data;
      setTimeline((current) => ({ ...next, events: [...(current?.events || []), ...(next.events || [])] }));
    } catch (e) { setTimeline((current) => ({ ...current, error: e })); }
    finally { setTimelineLoadingMore(false); }
  };
  const saveNotes = (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(Object.keys(dirtyNotes).filter((field) => dirtyNotes[field]).map((field) => [field, notes[field]]));
    if (!Object.keys(payload).length) { setActionError({ apiError: { message: t.noteRequired } }); return; }
    perform(() => doctorApi.updateNotes(id, payload), (data) => { setEncounter((current) => ({ ...current, ...data })); setNotes(Object.fromEntries(Object.keys(initialNotes).map((field) => [field, data[field] || '']))); setDirtyNotes({}); }, t.notesSaved);
  };
  const saveVitals = (event) => {
    event.preventDefault();
    const numeric = Object.fromEntries(Object.entries(vitalForm).filter(([, value]) => value !== '').map(([name, value]) => [name, Number(value)]));
    delete numeric.systolic; delete numeric.diastolic;
    const requestKey = requestKeys.current.vitals || (requestKeys.current.vitals = key());
    perform(() => doctorApi.recordVitals(id, { patient: encounter.patient, bloodPressure: { systolic: Number(vitalForm.systolic), diastolic: Number(vitalForm.diastolic) }, ...numeric, idempotencyKey: requestKey }), (data) => { setVitalForm({ systolic: '', diastolic: '', temperature: '', pulse: '', respiratoryRate: '', weight: '', height: '', oxygenSaturation: '' }); setVitals((current) => [data, ...current.filter((item) => item.id !== data.id)]); }, t.vitalsSaved, 'vitals');
  };
  const saveDiagnosis = (event) => {
    event.preventDefault();
    const payload = { patient: encounter.patient, description: diagnosisForm.description, isPrimary: diagnosisForm.isPrimary, idempotencyKey: key() };
    if (diagnosisForm.code.trim()) payload.code = diagnosisForm.code.trim();
    payload.idempotencyKey = requestKeys.current.diagnosis || (requestKeys.current.diagnosis = key());
    perform(() => doctorApi.addDiagnosis(id, payload), (data) => setDiagnoses((current) => [data, ...current.filter((item) => item.id !== data.id)]), t.diagnosisSaved, 'diagnosis');
  };
  const savePrescription = (event) => {
    event.preventDefault();
    const payload = { ...prescriptionForm, medicationId: prescriptionForm.medicationId.trim(), duration: Number(prescriptionForm.duration), quantity: Number(prescriptionForm.quantity), idempotencyKey: requestKeys.current.prescription || (requestKeys.current.prescription = key()) };
    if (!payload.overrideAllergyWarning) delete payload.allergyOverrideReason;
    perform(() => doctorApi.prescription(id, payload), () => setPrescriptionForm({ medicationId: '', dose: '', route: 'oral', frequency: '', duration: '', quantity: '', instructions: '', overrideAllergyWarning: false, allergyOverrideReason: '' }), t.prescriptionSaved, 'prescription');
  };
  const closeEncounter = () => {
    if (!window.confirm(t.confirmCloseEncounter)) return;
    perform(() => doctorApi.closeEncounter(id), setEncounter, t.encounterClosed);
  };
  const activateBreakGlass = (event) => {
    event.preventDefault(); setBreakGlassResult(null);
    perform(() => doctorApi.breakGlass(encounter.patient, { reason: breakGlassReason }), (data) => { setBreakGlassResult(data); setBreakGlassReason(''); }, t.breakGlassActivated);
  };
  const dateFormat = new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });

  if (loading) return <LoadingRows />;
  if (error) return <><PageTitle title={t.encounterWorkspace} action={<Link className="btn-secondary" to="/doctor">{t.backToEncounters}</Link>} /><Notice error={error} onRetry={load} /></>;
  if (!encounter) return null;

  return <>
    <PageTitle title={`${t.encounterWorkspace} · ${encounter.visitNumber}`} description={`${encounter.department} · ${t[encounter.visitType] || encounter.visitType} · ${t[encounter.status] || encounter.status}`} action={<Link className="btn-secondary" to="/doctor">{t.backToEncounters}</Link>} />
    <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900"><strong>{t.patientId}:</strong> {encounter.patient}<span className="ml-2">{t.noPatientDemographics}</span></div>
    <ActionMessage value={success} error={actionError} />
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <Panel title={t.clinicalNotes}>
        <form onSubmit={saveNotes} className="space-y-3">
          {Object.keys(initialNotes).map((field) => <Textarea key={field} label={t[field]} maxLength={['assessment', 'followUpInstructions'].includes(field) ? 5000 : 10000} value={notes[field]} onChange={(e) => { setNotes((v) => ({ ...v, [field]: e.target.value })); setDirtyNotes((v) => ({ ...v, [field]: true })); }} />)}
          <button disabled={busy} className="btn-primary">{busy ? t.saving : t.saveNotes}</button>
        </form>
      </Panel>
      <Panel title={t.vitals}>
        <form onSubmit={saveVitals} className="grid gap-3 sm:grid-cols-2">
          {[['systolic', 10, 350], ['diastolic', 5, 250], ['temperature', 10, 45], ['pulse', 1, 400], ['respiratoryRate', 1, 150], ['weight', 0.01, 1000], ['height', 5, 350], ['oxygenSaturation', 1, 100]].map(([field, min, max]) => <Field key={field} label={t[field]} type="number" step="any" min={min} max={max} required={['systolic', 'diastolic', 'temperature', 'pulse', 'weight'].includes(field)} value={vitalForm[field]} onChange={(e) => setVitalForm((v) => ({ ...v, [field]: e.target.value }))} />)}
          <div className="sm:col-span-2"><button disabled={busy} className="btn-primary">{t.recordVitals}</button></div>
        </form>
        <div className="mt-5 border-t border-slate-100 pt-4"><h3 className="text-sm font-semibold text-slate-800">{t.recordedVitals}</h3><Notice error={resourceErrors.vitals} onRetry={load} />{vitals.length === 0 ? <EmptyState>{t.noVitals}</EmptyState> : <div className="mt-3 space-y-2">{vitals.map((vital) => <div key={vital.id} className="rounded-lg bg-slate-50 p-3 text-sm"><p className="font-medium">{vital.bloodPressure.systolic}/{vital.bloodPressure.diastolic} mmHg · {vital.temperature} °C · {vital.pulse} bpm</p><p className="mt-1 text-xs text-slate-500">{dateFormat.format(new Date(vital.recordedAt))}{vital.abnormalFlags?.length ? ` · ${vital.abnormalFlags.map((flag) => `${flag.measurement}: ${flag.status}`).join(', ')}` : ''}</p></div>)}</div>}</div>
      </Panel>
      <Panel title={t.diagnoses}>
        <form onSubmit={saveDiagnosis} className="space-y-3"><Field label={t.icd10CodeOptional} value={diagnosisForm.code} onChange={(e) => setDiagnosisForm((v) => ({ ...v, code: e.target.value }))} maxLength={8} /><p className="text-xs text-slate-500">{t.icdCatalogGap}</p><Textarea label={t.diagnosisDescription} value={diagnosisForm.description} required={!diagnosisForm.code.trim()} maxLength={1000} onChange={(e) => setDiagnosisForm((v) => ({ ...v, description: e.target.value }))} /><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={diagnosisForm.isPrimary} onChange={(e) => setDiagnosisForm((v) => ({ ...v, isPrimary: e.target.checked }))} />{t.primaryDiagnosis}</label><button disabled={busy} className="btn-primary">{t.addDiagnosis}</button></form>
        <div className="mt-5 border-t border-slate-100 pt-4"><Notice error={resourceErrors.diagnoses} onRetry={load} />{diagnoses.length === 0 ? <EmptyState>{t.noDiagnoses}</EmptyState> : <ul className="space-y-2">{diagnoses.map((item) => <li key={item.id} className="rounded-lg bg-slate-50 p-3 text-sm"><strong>{item.code || '—'}</strong> · {item.description}{item.isPrimary && <span className="ml-2 text-xs font-semibold text-blue-800">{t.primary}</span>}</li>)}</ul>}</div>
      </Panel>
      <Panel title={t.prescriptions}>
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t.medicationCatalogGap} {t.allergyApiGap}</p>
        <form onSubmit={savePrescription} className="grid gap-3 sm:grid-cols-2"><Field label={t.medicationId} required value={prescriptionForm.medicationId} onChange={(e) => setPrescriptionForm((v) => ({ ...v, medicationId: e.target.value }))} /><Field label={t.dose} required value={prescriptionForm.dose} onChange={(e) => setPrescriptionForm((v) => ({ ...v, dose: e.target.value }))} /><label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.route}</span><select required value={prescriptionForm.route} onChange={(e) => setPrescriptionForm((v) => ({ ...v, route: e.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5">{['oral', 'injection', 'topical', 'inhalation', 'other'].map((route) => <option value={route} key={route}>{t[route] || route}</option>)}</select></label><Field label={t.frequency} required value={prescriptionForm.frequency} onChange={(e) => setPrescriptionForm((v) => ({ ...v, frequency: e.target.value }))} /><Field label={t.duration} type="number" required min="0.01" step="any" value={prescriptionForm.duration} onChange={(e) => setPrescriptionForm((v) => ({ ...v, duration: e.target.value }))} /><Field label={t.quantity} type="number" required min="0.01" step="any" value={prescriptionForm.quantity} onChange={(e) => setPrescriptionForm((v) => ({ ...v, quantity: e.target.value }))} /><div className="sm:col-span-2"><Textarea label={t.instructions} value={prescriptionForm.instructions} maxLength={2000} onChange={(e) => setPrescriptionForm((v) => ({ ...v, instructions: e.target.value }))} /></div>{(actionError?.apiError?.data?.allergyWarning || actionError?.response?.data?.data?.allergyWarning) && <><label className="sm:col-span-2 flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" checked={prescriptionForm.overrideAllergyWarning} onChange={(e) => setPrescriptionForm((v) => ({ ...v, overrideAllergyWarning: e.target.checked }))} /><span>{t.overrideAllergyWarning}</span></label>{prescriptionForm.overrideAllergyWarning && <div className="sm:col-span-2"><Textarea label={t.allergyOverrideReason} minLength={20} maxLength={1000} required value={prescriptionForm.allergyOverrideReason} onChange={(e) => setPrescriptionForm((v) => ({ ...v, allergyOverrideReason: e.target.value }))} /></div>}</>}<div className="sm:col-span-2"><button disabled={busy} className="btn-primary">{t.createPrescription}</button></div></form>
      </Panel>
      <Panel title={t.patientTimeline}>
        {timeline?.error && <Notice error={timeline.error} />}{!timeline?.events?.length ? <EmptyState>{t.noTimeline}</EmptyState> : <div className="space-y-3">{timeline.events.map((event) => <article key={`${event.type}-${event.id}`} className="border-l-2 border-blue-200 pl-3"><p className="text-xs font-semibold uppercase tracking-wide text-blue-800">{t[event.type] || event.type} · {dateFormat.format(new Date(event.date))}</p><p className="mt-1 text-sm font-medium text-slate-800">{event.type === 'encounter' ? `${event.details.department} · ${event.details.status}` : event.type === 'diagnosis' ? `${event.details.code || ''} ${event.details.description}` : event.type === 'vital' ? `${event.details.bloodPressure?.systolic}/${event.details.bloodPressure?.diastolic} mmHg · ${event.details.temperature} °C · ${event.details.pulse} bpm` : event.details?.drugName || event.details?.testName || event.details?.specialist || event.details?.status || ''}</p>{event.details?.chiefComplaint && <p className="mt-1 text-sm text-slate-600">{event.details.chiefComplaint}</p>}{event.details?.clinicalNotes && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{event.details.clinicalNotes}</p>}{event.details?.assessment && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{event.details.assessment}</p>}</article>)}</div>}
        {timeline?.pagination?.hasMore && <button disabled={timelineLoadingMore} onClick={loadMoreTimeline} className="btn-secondary mt-3">{timelineLoadingMore ? t.loadingData : t.next}</button>}
        <p className="mt-3 text-xs text-slate-500">{t.timelineConsentNotice}</p>
      </Panel>
      <Panel title={t.breakGlass}>
        <p className="mb-3 text-sm text-slate-600">{t.breakGlassNotice}</p>
        <form onSubmit={activateBreakGlass} className="space-y-3"><Textarea label={t.emergencyReason} required minLength={20} maxLength={2000} value={breakGlassReason} onChange={(e) => setBreakGlassReason(e.target.value)} /><button disabled={busy} className="btn-secondary">{t.activateBreakGlass}</button></form>
        {breakGlassResult && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{t.breakGlassExpires}: {dateFormat.format(new Date(breakGlassResult.expiresAt))}</p>}
      </Panel>
    </div>
    <div className="mt-5 flex justify-end">{encounter.status !== 'closed' && <button className="btn-secondary" disabled={busy} onClick={closeEncounter}>{t.closeEncounter}</button>}</div>
  </>;
}
