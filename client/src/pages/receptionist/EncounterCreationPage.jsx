import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { receptionApi } from '../../api/receptionApi.js';
import { Field, Notice, PageTitle, Panel } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

const freshKey = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128);

export default function EncounterCreationPage({ onCreated }) {
  const { t, language } = useLanguage();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const key = useRef(freshKey());
  const [patients, setPatients] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [patientSearch, setPatientSearch] = useState('');
  const [selectedPatient, setSelectedPatient] = useState(searchParams.get('patient') || '');
  const [form, setForm] = useState({ department: '', visitType: 'outpatient', chiefComplaint: '' });
  const [busy, setBusy] = useState(false);
  const [loadingDepartments, setLoadingDepartments] = useState(true);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [partial, setPartial] = useState(false);
  const text = language === 'so'
    ? { departments: 'Waaxda', departmentHelp: 'Dooro waax firfircoon oo uu maamuluhu dejiyey.', noDepartments: 'Ma jiro waax firfircoon. Maamuluhu waa inuu marka hore ku daraa bogga Maareynta Waaxyaha.', retry: 'Dib u tijaabi', loadError: 'Waaxyaha lama soo rari karin.' }
    : { departments: 'Department', departmentHelp: 'Choose an active department configured by an administrator.', noDepartments: 'No active departments are configured. Ask an administrator to add one in Department Management first.', retry: 'Retry', loadError: 'Departments could not be loaded.' };

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => receptionApi.departments()).then((response) => {
      if (active) setDepartments(response.data.data?.departments || []);
    }).catch((requestError) => { if (active) setError(requestError); })
      .finally(() => { if (active) setLoadingDepartments(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const search = patientSearch.trim().slice(0, 100);
    Promise.resolve().then(() => receptionApi.patients({ page: 1, limit: 20, ...(search ? { search } : {}) })).then((response) => {
      if (active) setPatients(response.data.data?.patients || []);
    }).catch(() => { if (active) setPatients([]); });
    return () => { active = false; };
  }, [patientSearch]);

  async function submit(event) {
    event.preventDefault(); setError(null);
    if (!/^[a-f\d]{24}$/i.test(selectedPatient)) { setError({ apiError: { message: t.selectPatientError } }); return; }
    if (!form.department || form.chiefComplaint.length > 2000) { setError({ apiError: { message: t.encounterValidation } }); return; }
    setBusy(true);
    try {
      const result = (await receptionApi.createEncounter({ patient: selectedPatient, department: form.department, visitType: form.visitType, ...(form.chiefComplaint.trim() ? { chiefComplaint: form.chiefComplaint.trim() } : {}), idempotencyKey: key.current })).data.data;
      setCreated(result); onCreated?.(result); window.dispatchEvent(new CustomEvent('hospital-emr:reception-encounter-created', { detail: result })); setPartial(false);
    } catch (requestError) { setError(requestError); if (requestError.apiError?.partialSuccess || requestError.apiError?.status === 503) setPartial(true); else key.current = freshKey(); }
    finally { setBusy(false); }
  }

  return <>
    <PageTitle title={t.createEncounter} description={t.encounterCreationDescription} action={<Link className="btn-secondary" to="/receptionist">{t.dashboard}</Link>} />
    {error && <Notice error={error} />}
    {partial && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{t.encounterPartial}</p>}
    {created && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5" role="status"><p className="font-semibold text-emerald-800">{t.encounterCreated}</p><p className="mt-2 text-lg font-bold text-emerald-950">{created.visitNumber}</p><p className="text-sm text-emerald-800">{t.noDoctorAssignmentReception}</p><button className="btn-secondary mt-3" onClick={() => navigate('/receptionist', { state: { createdEncounter: created } })} type="button">{t.viewRecentActivity}</button><button className="ml-2 mt-3 text-sm font-semibold text-blue-700" onClick={() => navigate('/receptionist/encounters/new')} type="button">{t.createAnotherEncounter}</button></div>}
    {!created && <Panel title={t.encounterDetails}>
      {departments.length === 0 && !loadingDepartments && !error && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{text.noDepartments}</p>}
      {loadingDepartments && <p className="mb-4 text-sm text-slate-500" role="status">{t.loading}</p>}
      {!loadingDepartments && error && <button className="mb-4 text-sm font-semibold text-blue-700" onClick={() => { setLoadingDepartments(true); setError(null); receptionApi.departments().then((response) => setDepartments(response.data.data?.departments || [])).catch(setError).finally(() => setLoadingDepartments(false)); }} type="button">{text.retry}</button>}
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><Field disabled={partial} label={t.searchPatients} maxLength={100} value={patientSearch} onChange={(event) => setPatientSearch(event.target.value)} /></div>
        <label className="block space-y-1.5 text-sm font-medium text-slate-700 sm:col-span-2"><span>{t.patient}</span><select disabled={partial} className="form-input block w-full" value={selectedPatient} required onChange={(event) => setSelectedPatient(event.target.value)}><option value="">{t.selectOption}</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.mrn} — {patient.firstName} {patient.fatherName} {patient.grandfatherName}</option>)}</select></label>
        <p className="text-xs text-slate-500 sm:col-span-2">{t.identityDirectoryOnly}</p>
        <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{text.departments}</span><select disabled={partial || loadingDepartments || departments.length === 0} className="form-input block w-full" value={form.department} required onChange={(event) => setForm((current) => ({ ...current, department: event.target.value }))}><option value="">{t.selectOption}</option>{departments.map((department) => <option key={department.id} value={department.code}>{department.name} ({department.code})</option>)}</select><span className="text-xs font-normal text-slate-500">{text.departmentHelp}</span></label>
        <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.visitType}</span><select disabled={partial} className="form-input block w-full" value={form.visitType} onChange={(event) => setForm((current) => ({ ...current, visitType: event.target.value }))}><option value="outpatient">{t.outpatient}</option><option value="inpatient">{t.inpatient}</option><option value="emergency">{t.emergency}</option></select></label>
        <label className="block space-y-1.5 text-sm font-medium text-slate-700 sm:col-span-2"><span>{t.registrationReasonOptional}</span><textarea disabled={partial} className="form-input block min-h-24 w-full" maxLength={2000} value={form.chiefComplaint} onChange={(event) => setForm((current) => ({ ...current, chiefComplaint: event.target.value }))} /></label>
        <p className="text-xs text-slate-500 sm:col-span-2">{t.noDoctorAssignmentReception}</p>
        <div className="sm:col-span-2"><button type="submit" className="btn-primary" disabled={busy || partial || loadingDepartments || departments.length === 0}>{busy ? t.saving : t.createEncounter}</button></div>
      </form>
    </Panel>}
  </>;
}
