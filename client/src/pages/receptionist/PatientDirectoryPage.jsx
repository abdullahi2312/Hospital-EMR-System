import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { receptionApi } from '../../api/receptionApi.js';
import { Field, LoadingRows, Notice, PageTitle, Pagination, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

function responseData(response) { return response.data?.data; }

export function PatientDirectoryPage() {
  const { t, language } = useLanguage(); const [search, setSearch] = useState(''); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setData(responseData(await receptionApi.patients({ page, limit: 20, ...(query ? { search: query } : {}) }))); } catch (e) { setError(e); } finally { setLoading(false); } }, [page, query]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  function submit(event) { event.preventDefault(); setPage(1); setQuery(search.trim().slice(0, 100)); }
  return <><PageTitle title={t.patientDirectory} description={t.patientDirectoryDescription} action={<Link className="btn-primary" to="/receptionist/register">{t.registerPatient}</Link>} /><Notice error={error} onRetry={load} /><Panel title={t.registeredPatients} action={<span className="text-xs text-slate-500">{data?.pagination?.total ?? '—'} {t.records}</span>}><form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={submit}><div className="w-full max-w-sm"><Field label={t.searchPatients} maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} /></div><button className="btn-secondary" type="submit">{t.search}</button></form>{loading ? <LoadingRows /> : <Table rows={data?.patients || []} empty={t.noPatients} columns={[
    { key: 'mrn', label: t.mrn, render: (row) => <Link className="font-semibold text-blue-700 hover:underline" to={`/receptionist/patients/${row.id}`}>{row.mrn}</Link> },
    { key: 'name', label: t.patientName, render: (row) => `${row.firstName} ${row.fatherName} ${row.grandfatherName}` },
    { key: 'sex', label: t.sex, render: (row) => row.sex === 'female' ? t.female : t.male },
    { key: 'registeredAt', label: t.registered, render: (row) => new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium' }).format(new Date(row.registeredAt)) }
  ]} />}<Pagination value={data?.pagination} onChange={setPage} /><p className="mt-4 text-xs text-slate-500">{t.identityOnlyNotice}</p></Panel></>;
}

export function PatientIdentityPage() {
  const { id } = useParams(); const { t, language } = useLanguage(); const [patient, setPatient] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setPatient(responseData(await receptionApi.patient(id))); } catch (e) { setError(e); } finally { setLoading(false); } }, [id]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  return <><PageTitle title={t.patientDetails} action={<Link className="btn-secondary" to="/receptionist/patients">{t.backToPatients}</Link>} /><Notice error={error} onRetry={load} />{loading ? <LoadingRows /> : patient && <Panel title={`${patient.firstName} ${patient.fatherName} ${patient.grandfatherName}`} action={<Link className="btn-primary" to={`/receptionist/encounters/new?patient=${encodeURIComponent(patient.id)}`}>{t.createEncounter}</Link>}><dl className="grid gap-5 sm:grid-cols-2">{[[t.mrn, patient.mrn], [t.patientId, patient.id], [t.sex, patient.sex === 'female' ? t.female : t.male], [t.dateOfBirth, patient.dateOfBirth ? new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US').format(new Date(patient.dateOfBirth)) : t.notProvided], [t.estimatedAge, patient.estimatedAge ?? t.notProvided], [t.registered, new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(patient.registeredAt))]].map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 break-all text-sm text-slate-800">{value}</dd></div>)}</dl><p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">{t.identityOnlyNotice}</p></Panel>}</>;
}
