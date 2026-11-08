import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPortalConsents, getPortalDoctors, getPortalLabResults, getPortalPrescriptions, getPortalProfile, getPortalSummaryPdf, getPortalVisits, grantPortalConsent, revokePortalConsent } from '../../api/patientPortalApi.js';
import { EmptyState, Notice, PageTitle, Pagination, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

const words = {
  en: { overview: 'Your care overview', intro: 'Private access to your own hospital records.', profile: 'Patient identity', visits: 'Visits', labs: 'Laboratory results', prescriptions: 'Prescriptions', consents: 'Care access permissions', download: 'Download PDF summary', mrn: 'MRN', registered: 'Registered', sex: 'Sex', age: 'Age', noRecords: 'No records are available.', visitHistory: 'Visit history', labHistory: 'Laboratory results', prescriptionHistory: 'Prescription history', visit: 'Visit', department: 'Department', type: 'Visit type', status: 'Status', opened: 'Opened', test: 'Test', component: 'Component', result: 'Result', reference: 'Reference range', flag: 'Flag', prescribed: 'Prescribed', medication: 'Medication', dose: 'Dose', route: 'Route', frequency: 'Frequency', duration: 'Duration', quantity: 'Quantity', date: 'Date', loading: 'Loading your records…', retry: 'Retry', doctorId: 'Doctor account ID', doctorHint: 'Enter the doctor account ID provided by your care team. The system does not provide a doctor directory.', grant: 'Grant access', revoke: 'Revoke', granted: 'Granted', revoked: 'Revoked', consentScope: 'Clinical record', noConsents: 'You have not managed any care access permissions.', confirmRevoke: 'Revoke this doctor’s access?', saved: 'Permission updated.', consentDate: 'Updated', privacy: 'Only information linked to your own patient account is shown. Access to your portal records is audited.', downloadError: 'Could not download the summary PDF.' },
  so: { overview: 'Soo koobidda daryeelkaaga', intro: 'Gelitaan gaar ah oo ku saabsan diiwaankaaga isbitaalka.', profile: 'Aqoonsiga bukaanka', visits: 'Booqashooyinka', labs: 'Natiijooyinka shaybaarka', prescriptions: 'Daawo-qorisyada', consents: 'Oggolaanshaha gelitaanka daryeelka', download: 'Soo dejiso PDF-ka kooban', mrn: 'MRN', registered: 'La diiwaangeliyay', sex: 'Jinsi', age: 'Daâ€™', noRecords: 'Wax diiwaan ah lama helin.', visitHistory: 'Taariikhda booqashooyinka', labHistory: 'Natiijooyinka shaybaarka', prescriptionHistory: 'Taariikhda daawo-qorista', visit: 'Booqasho', department: 'Waax', type: 'Nooca booqashada', status: 'Xaalad', opened: 'La furay', test: 'Baaritaan', component: 'Qayb', result: 'Natiijo', reference: 'Xadka tixraaca', flag: 'Calaamad', prescribed: 'La qoray', medication: 'Daawo', dose: 'Qiyaas', route: 'Habka', frequency: 'Inta jeer', duration: 'Muddada', quantity: 'Tiro', date: 'Taariikh', loading: 'Diiwaankaaga ayaa la soo rarayaa…', retry: 'Ku celi', doctorId: 'Aqoonsiga akoonka dhakhtarka', doctorHint: 'Geli aqoonsiga akoonka dhakhtarka ee kooxda daryeelka ku siisay. Nidaamku ma hayo liiska dhakhaatiirta.', grant: 'Oggolow gelitaanka', revoke: 'Ka noqo', granted: 'La oggolaaday', revoked: 'Laga noqday', consentScope: 'Diiwaanka caafimaadka', noConsents: 'Ma lihid oggolaansho gelitaan oo aad maamushay.', confirmRevoke: 'Ma ka noqonaysaa gelitaanka dhakhtarkan?', saved: 'Oggolaanshaha waa la cusboonaysiiyay.', consentDate: 'La cusboonaysiiyay', privacy: 'Waxaa la muujinayaa oo keliya xogta ku xiran akoonkaaga bukaanka. Gelitaanka waa la diiwaangeliyaa.', downloadError: 'PDF-ka lama soo dejin karin.' }
};

const consentWords = {
  en: { doctorName: 'Doctor', doctorSearch: 'Search doctors by name', search: 'Search', selectDoctor: 'Select a doctor', noDoctors: 'No active doctors match this search.' },
  so: { doctorName: 'Dhakhtar', doctorSearch: 'Ku raadi dhakhtarka magaciisa', search: 'Raadi', selectDoctor: 'Dooro dhakhtar', noDoctors: 'Dhakhtar firfircoon oo ku habboon lama helin.' }
};

function usePortalText() { const { language } = useLanguage(); return { ...(words[language] || words.en), ...consentWords[language] }; }

function usePortalRequest(request, initialData) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const run = useCallback(async () => {
    setLoading(true); setError(null);
    try { const response = await request(); setData(response.data.data); }
    catch (requestError) { setError(requestError); }
    finally { setLoading(false); }
  }, [request]);
  useEffect(() => {
    const timer = window.setTimeout(run, 0);
    return () => window.clearTimeout(timer);
  }, [run]);
  return { data, loading, error, retry: run, setData };
}

function StateBlock({ loading, error, retry, empty, children }) {
  const t = usePortalText();
  if (loading) return <div className="py-10 text-center text-sm text-slate-500" role="status">{t.loading}</div>;
  if (error) return <Notice error={error} onRetry={retry} />;
  if (empty) return <EmptyState>{t.noRecords}</EmptyState>;
  return children;
}

function downloadBlob(response, filename) {
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

export function PatientDashboardPage() {
  const t = usePortalText();
  const requestProfile = useCallback(() => getPortalProfile(), []);
  const requestVisits = useCallback(() => getPortalVisits({ page: 1, limit: 1 }), []);
  const requestLabs = useCallback(() => getPortalLabResults({ page: 1, limit: 1 }), []);
  const requestPrescriptions = useCallback(() => getPortalPrescriptions({ page: 1, limit: 1 }), []);
  const profile = usePortalRequest(requestProfile, null);
  const visits = usePortalRequest(requestVisits, null);
  const labs = usePortalRequest(requestLabs, null);
  const prescriptions = usePortalRequest(requestPrescriptions, null);
  const [pdfError, setPdfError] = useState('');
  async function handleDownload() {
    setPdfError('');
    try { downloadBlob(await getPortalSummaryPdf(), 'patient-summary.pdf'); }
    catch { setPdfError(t.downloadError); }
  }
  return <>
    <PageTitle title={t.overview} description={t.intro} action={<button type="button" onClick={handleDownload} className="btn-primary">{t.download}</button>} />
    {pdfError && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{pdfError}</div>}
    <StateBlock loading={profile.loading} error={profile.error} retry={profile.retry} empty={!profile.data}>
      <Panel title={t.profile}><dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[[t.profile, profile.data?.name], [t.mrn, profile.data?.mrn], [t.sex, profile.data?.sex], [t.registered, profile.data?.registeredAt ? new Date(profile.data.registeredAt).toLocaleDateString() : '—']].map(([label, value]) => <div key={label}><dt className="text-xs font-medium text-slate-500">{label}</dt><dd className="mt-1 break-words text-sm font-semibold text-slate-900">{value || '—'}</dd></div>)}</dl></Panel>
    </StateBlock>
    <div className="mt-5 grid gap-4 sm:grid-cols-3">{[[t.visits, visits.data?.pagination?.total, '/patient/visits'], [t.labs, labs.data?.pagination?.total, '/patient/lab-results'], [t.prescriptions, prescriptions.data?.pagination?.total, '/patient/prescriptions']].map(([label, count, path]) => <Link key={path} to={path} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-blue-300"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold text-slate-900">{count ?? '—'}</p></Link>)}</div>
    <p className="mt-5 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">{t.privacy}</p>
  </>;
}

function usePaginated(getPage) {
  const [page, setPage] = useState(1);
  const request = useCallback(() => getPage({ page, limit: 20 }), [getPage, page]);
  const state = usePortalRequest(request, null);
  return { ...state, page, setPage };
}

export function PatientVisitsPage() {
  const t = usePortalText();
  const getPage = useCallback((params) => getPortalVisits(params), []);
  const { data, loading, error, retry, setPage } = usePaginated(getPage);
  const rows = data?.encounters || [];
  const columns = [{ key: 'visitNumber', label: t.visit }, { key: 'department', label: t.department }, { key: 'visitType', label: t.type }, { key: 'status', label: t.status }, { key: 'openedAt', label: t.opened, render: (row) => row.openedAt ? new Date(row.openedAt).toLocaleDateString() : '—' }];
  return <><PageTitle title={t.visitHistory} description={t.privacy} /><Panel title={t.visits}><StateBlock loading={loading} error={error} retry={retry} empty={!loading && !error && rows.length === 0}><Table columns={columns} rows={rows} empty={t.noRecords} /><Pagination value={data?.pagination} onChange={setPage} /></StateBlock></Panel></>;
}

export function PatientLabResultsPage() {
  const t = usePortalText();
  const getPage = useCallback((params) => getPortalLabResults(params), []);
  const { data, loading, error, retry, setPage } = usePaginated(getPage);
  const rows = data?.results || [];
  const columns = [{ key: 'testName', label: t.test }, { key: 'componentName', label: t.component, render: (row) => row.componentName || '—' }, { key: 'result', label: t.result, render: (row) => row.resultType === 'numeric' ? `${row.numericValue ?? ''} ${row.unit || ''}` : row.textValue || '—' }, { key: 'referenceRange', label: t.reference, render: (row) => row.referenceRange ? `${row.referenceRange.minimum ?? '—'} – ${row.referenceRange.maximum ?? '—'}` : '—' }, { key: 'flag', label: t.flag, render: (row) => <span className={row.flag === 'high' || row.flag === 'low' ? 'font-semibold text-rose-700' : ''}>{row.flag || '—'}</span> }, { key: 'resultedAt', label: t.date, render: (row) => row.resultedAt ? new Date(row.resultedAt).toLocaleDateString() : '—' }];
  return <><PageTitle title={t.labHistory} description={t.privacy} /><Panel title={t.labs}><StateBlock loading={loading} error={error} retry={retry} empty={!loading && !error && rows.length === 0}><Table columns={columns} rows={rows} empty={t.noRecords} /><Pagination value={data?.pagination} onChange={setPage} /></StateBlock></Panel></>;
}

export function PatientPrescriptionsPage() {
  const t = usePortalText();
  const getPage = useCallback((params) => getPortalPrescriptions(params), []);
  const { data, loading, error, retry, setPage } = usePaginated(getPage);
  const rows = data?.prescriptions || [];
  const columns = [{ key: 'drugName', label: t.medication }, { key: 'dose', label: t.dose }, { key: 'route', label: t.route }, { key: 'frequency', label: t.frequency }, { key: 'duration', label: t.duration, render: (row) => row.duration }, { key: 'quantity', label: t.quantity }, { key: 'status', label: t.status }, { key: 'prescribedAt', label: t.prescribed, render: (row) => row.prescribedAt ? new Date(row.prescribedAt).toLocaleDateString() : '—' }];
  return <><PageTitle title={t.prescriptionHistory} description={t.privacy} /><Panel title={t.prescriptions}><StateBlock loading={loading} error={error} retry={retry} empty={!loading && !error && rows.length === 0}><Table columns={columns} rows={rows} empty={t.noRecords} /><Pagination value={data?.pagination} onChange={setPage} /></StateBlock></Panel></>;
}

export function PatientConsentsPage() {
  const t = usePortalText();
  const [doctorId, setDoctorId] = useState('');
  const [doctorSearch, setDoctorSearch] = useState('');
  const [doctorQuery, setDoctorQuery] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useCallback(() => getPortalConsents(), []);
  const state = usePortalRequest(request, null);
  const rows = state.data?.consents || [];
  const doctorRequest = useCallback(() => getPortalDoctors({ page: 1, limit: 100, ...(doctorQuery ? { search: doctorQuery } : {}) }), [doctorQuery]);
  const doctorState = usePortalRequest(doctorRequest, null);
  const doctors = doctorState.data?.doctors || [];
  const doctorNames = new Map(doctors.map((doctor) => [doctor.id, doctor.fullName]));
  async function grant(event) {
    event.preventDefault(); setFormError(''); setBusy(true);
    try { await grantPortalConsent({ doctorId, scope: 'clinical_record' }); setDoctorId(''); await state.retry(); }
    catch (error) { setFormError(error.apiError?.message || error.response?.data?.message || t.noRecords); }
    finally { setBusy(false); }
  }
  async function revoke(id) {
    if (!window.confirm(t.confirmRevoke)) return;
    setFormError(''); setBusy(true);
    try { await revokePortalConsent(id); await state.retry(); }
    catch (error) { setFormError(error.apiError?.message || error.response?.data?.message || t.noRecords); }
    finally { setBusy(false); }
  }
  const columns = [
    { key: 'doctor', label: t.doctorName, render: (row) => doctorNames.get(row.doctor) || row.doctor },
    { key: 'scope', label: t.consentScope },
    { key: 'status', label: t.status, render: (row) => row.status === 'granted' ? t.granted : t.revoked },
    { key: 'updatedAt', label: t.consentDate, render: (row) => row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—' },
    { key: 'action', label: '', render: (row) => row.status === 'granted' ? <button type="button" disabled={busy} onClick={() => revoke(row.id)} className="font-semibold text-rose-700 disabled:opacity-50">{t.revoke}</button> : null }
  ];
  return <>
    <PageTitle title={t.consents} description={t.privacy} />
    <Panel title={t.grant}>
      <div className="max-w-2xl space-y-4">
        <form onSubmit={(event) => { event.preventDefault(); setDoctorQuery(doctorSearch.trim()); }} className="flex flex-col gap-2 sm:flex-row">
          <input aria-label={t.doctorSearch} value={doctorSearch} onChange={(event) => setDoctorSearch(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm" placeholder={t.doctorSearch} />
          <button type="submit" className="btn-secondary">{t.search}</button>
        </form>
        <StateBlock loading={doctorState.loading} error={doctorState.error} retry={doctorState.retry} empty={false}>
          <form onSubmit={grant} className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium text-slate-700">
              <span>{t.doctorName}</span>
              <select required value={doctorId} onChange={(event) => setDoctorId(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5">
                <option value="">{t.selectDoctor}</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.fullName}</option>)}
              </select>
            </label>
            {!doctors.length && <p className="text-sm text-slate-500">{t.noDoctors}</p>}
            {formError && <p role="alert" className="text-sm text-rose-700">{formError}</p>}
            <button disabled={busy || !doctorId} className="btn-primary" type="submit">{busy ? t.loading : t.grant}</button>
          </form>
        </StateBlock>
      </div>
    </Panel>
    <div className="mt-5"><Panel title={t.consents}><StateBlock loading={state.loading} error={state.error} retry={state.retry} empty={!state.loading && !state.error && rows.length === 0}><Table columns={columns} rows={rows} empty={t.noConsents} /></StateBlock></Panel></div>
  </>;
}
