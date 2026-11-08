import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { receptionApi } from '../../api/receptionApi.js';
import { Field, Notice, PageTitle, Panel } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

const createIdempotencyKey = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128);

export default function PatientRegistrationPage({ onRegistered }) {
  const { t } = useLanguage();
  const keyRef = useRef(createIdempotencyKey());
  const [form, setForm] = useState({ firstName: '', fatherName: '', grandfatherName: '', sex: '', dateOfBirth: '', estimatedAge: '', phone: '', district: '', emergencyContact: '', allergyStatus: 'not_recorded', allergies: [''] });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [patient, setPatient] = useState(null); const [retryKind, setRetryKind] = useState(null);
  function update(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  function valid() {
    if ([form.firstName, form.fatherName, form.grandfatherName].some((name) => !name.trim() || name.trim().length > 100)) return t.patientNameValidation;
    if (!['male', 'female'].includes(form.sex)) return t.sexRequired;
    if (!form.dateOfBirth && form.estimatedAge === '') return t.ageRequired;
    if (form.estimatedAge !== '' && (!Number.isFinite(Number(form.estimatedAge)) || Number(form.estimatedAge) < 0 || Number(form.estimatedAge) > 150)) return t.ageRangeError;
    if (form.dateOfBirth && new Date(`${form.dateOfBirth}T00:00:00`) > new Date()) return t.futureBirthDate;
    if (form.phone.length > 30 || (form.phone && !/[0-9]/.test(form.phone))) return t.phoneInvalid;
    if (form.district.length > 100 || form.emergencyContact.length > 100) return t.optionalFieldLimit;
    if (form.allergies.some((value) => value.trim().length > 100)) return t.allergyLimit;
    if (form.allergyStatus === 'recorded' && !form.allergies.some((value) => value.trim())) return t.allergyRequired;
    return null;
  }
  async function submit(event) {
    event.preventDefault(); setError(null);
    const message = valid();
    if (message) { setError({ apiError: { message } }); return; }
    const payload = {
      firstName: form.firstName, fatherName: form.fatherName, grandfatherName: form.grandfatherName, sex: form.sex,
      ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
      ...(form.estimatedAge !== '' ? { estimatedAge: Number(form.estimatedAge) } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}), ...(form.district.trim() ? { district: form.district.trim() } : {}),
      ...(form.emergencyContact.trim() ? { emergencyContact: form.emergencyContact.trim() } : {}),
      allergyStatus: form.allergyStatus,
      ...(form.allergyStatus === 'recorded' ? { allergies: form.allergies.filter((value) => value.trim()) } : {}),
      idempotencyKey: keyRef.current
    };
    setBusy(true);
    try {
      const result = (await receptionApi.registerPatient(payload)).data.data;
      setPatient(result); setRetryKind(null); onRegistered?.(result);
    } catch (requestError) {
      setError(requestError);
      const apiError = requestError.apiError || {};
      const configUnavailable = apiError.data?.code === 'PATIENT_IDEMPOTENCY_NOT_CONFIGURED';
      const retrySameKey = apiError.partialSuccess === true || apiError.retrySameKey === true ||
        apiError.isNetworkError === true || Number(apiError.status) >= 500;
      if (retrySameKey) setRetryKind(configUnavailable ? 'configuration' : 'uncertain');
      else { setRetryKind(null); keyRef.current = createIdempotencyKey(); }
    } finally { setBusy(false); }
  }
  function resetForm() {
    setPatient(null); setError(null); setRetryKind(null); keyRef.current = createIdempotencyKey();
    setForm({ firstName: '', fatherName: '', grandfatherName: '', sex: '', dateOfBirth: '', estimatedAge: '', phone: '', district: '', emergencyContact: '', allergyStatus: 'not_recorded', allergies: [''] });
  }
  const editLocked = retryKind !== null;
  return <>
    <PageTitle title={t.patientRegistration} description={t.registrationDescription} action={<Link className="btn-secondary" to="/receptionist/patients">{t.openDirectory}</Link>} />
    {error && <Notice error={error} />}
    {retryKind && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">{retryKind === 'configuration' ? t.registrationConfigurationError : t.registrationPartial} <button type="button" className="ml-1 font-semibold underline" onClick={submit}>{t.retrySameSubmission}</button></div>}
    {patient && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5" role="status"><p className="text-sm font-semibold text-emerald-800">{t.registrationSuccess}</p><p className="mt-2 text-2xl font-bold tracking-wide text-emerald-950">{patient.mrn}</p><p className="mt-1 text-sm text-emerald-800">{t.mrnAssignedByServer}</p><button className="btn-secondary mt-4" onClick={resetForm} type="button">{t.registerAnother}</button></div>}
    {!patient && <Panel title={t.patientIdentity}><form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field disabled={editLocked} label={t.firstNameSomali} name="firstName" required maxLength={100} autoComplete="off" value={form.firstName} onChange={update} />
      <Field disabled={editLocked} label={t.fatherNameSomali} name="fatherName" required maxLength={100} autoComplete="off" value={form.fatherName} onChange={update} />
      <Field disabled={editLocked} label={t.grandfatherNameSomali} name="grandfatherName" required maxLength={100} autoComplete="off" value={form.grandfatherName} onChange={update} />
      <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.sex}</span><select disabled={editLocked} className="form-input block w-full" name="sex" required value={form.sex} onChange={update}><option value="">{t.selectOption}</option><option value="female">{t.female}</option><option value="male">{t.male}</option></select></label>
      <Field disabled={editLocked} label={t.dateOfBirth} name="dateOfBirth" type="date" max={new Date().toISOString().slice(0, 10)} value={form.dateOfBirth} onChange={update} />
      <Field disabled={editLocked} label={t.estimatedAge} name="estimatedAge" type="number" min="0" max="150" step="any" value={form.estimatedAge} onChange={update} />
      <p className="text-xs text-slate-500 sm:col-span-2">{t.dateOrAgeRequirement}</p>
      <Field disabled={editLocked} label={t.phoneOptional} name="phone" maxLength={30} value={form.phone} onChange={update} />
      <Field disabled={editLocked} label={t.districtOptional} name="district" maxLength={100} value={form.district} onChange={update} />
      <Field disabled={editLocked} label={t.emergencyContactOptional} name="emergencyContact" maxLength={100} value={form.emergencyContact} onChange={update} />
      <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.allergyStatus}</span><select disabled={editLocked} className="form-input block w-full" name="allergyStatus" value={form.allergyStatus} onChange={update}><option value="not_recorded">{t.notRecorded}</option><option value="none_known">{t.noneKnown}</option><option value="recorded">{t.recorded}</option></select></label>
      {form.allergyStatus === 'recorded' && <div className="space-y-2 sm:col-span-2"><span className="block text-sm font-medium text-slate-700">{t.allergies}</span>{form.allergies.map((value, index) => <Field key={index} disabled={editLocked} aria-label={`${t.allergies} ${index + 1}`} maxLength={100} value={value} onChange={(event) => setForm((current) => ({ ...current, allergies: current.allergies.map((item, i) => i === index ? event.target.value : item) }))} />)}<button type="button" disabled={editLocked} className="text-sm font-semibold text-blue-700" onClick={() => setForm((current) => ({ ...current, allergies: [...current.allergies, ''] }))}>{t.addAllergy}</button></div>}
      <div className="sm:col-span-2"><p className="text-xs text-slate-500">{t.registrationPrivacyNote}</p><button className="btn-primary mt-4" type="submit" disabled={busy || editLocked}>{busy ? t.saving : t.registerPatient}</button></div>
    </form></Panel>}
  </>;
}
