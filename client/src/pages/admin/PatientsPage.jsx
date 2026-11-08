import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, responseData } from '../../api/adminApi.js';
import { Field, LoadingRows, Notice, PageTitle, Pagination, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export function PatientsPage() {
  const { t } = useLanguage(); const [search, setSearch] = useState(''); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setData(responseData(await adminApi.patients({ page, limit: 20, ...(query.trim() ? { search: query.trim() } : {}) }))); } catch (e) { setError(e); } finally { setLoading(false); } }, [page, query]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  function submit(event) { event.preventDefault(); setPage(1); setQuery(search); }
  return <><PageTitle title={t.patientDirectory} description={t.patientDirectoryDescription} /><Notice error={error} onRetry={load} /><Panel title={t.registeredPatients} action={<span className="text-xs text-slate-500">{data?.pagination?.total ?? '—'} {t.records}</span>}><form className="mb-4 flex flex-wrap gap-2" onSubmit={submit}><div className="w-full max-w-sm"><Field aria-label={t.searchPatients} placeholder={t.searchPatients} value={search} onChange={(e) => setSearch(e.target.value)} /></div><button className="btn-secondary" type="submit">{t.search}</button></form>{loading ? <LoadingRows /> : <Table rows={data?.patients || []} empty={t.noPatients} columns={[
    { key: 'mrn', label: t.mrn, render: (row) => <Link className="font-semibold text-blue-700 hover:underline" to={`/admin/patients/${row.id}`}>{row.mrn}</Link> },
    { key: 'name', label: t.patientName, render: (row) => `${row.firstName} ${row.fatherName} ${row.grandfatherName}` },
    { key: 'sex', label: t.sex, render: (row) => row.sex === 'female' ? t.female : t.male },
    { key: 'registeredAt', label: t.registered, render: (row) => new Date(row.registeredAt).toLocaleDateString() }
  ]} />}<Pagination value={data?.pagination} onChange={setPage} /><p className="mt-4 text-xs text-slate-500">{t.identityOnlyNotice}</p></Panel></>;
}

export function PatientDetailsPage() {
  const { id } = useParams(); const { t } = useLanguage(); const [patient, setPatient] = useState(null); const [error, setError] = useState(null); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setPatient(responseData(await adminApi.patient(id))); } catch (e) { setError(e); } finally { setLoading(false); } }, [id]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  return <><PageTitle title={t.patientDetails} action={<Link className="btn-secondary" to="/admin/patients">{t.backToPatients}</Link>} /><Notice error={error} onRetry={load} />{loading ? <LoadingRows /> : patient && <Panel title={`${patient.firstName} ${patient.fatherName} ${patient.grandfatherName}`}><dl className="grid gap-5 sm:grid-cols-2">{[[t.mrn, patient.mrn], [t.patientId, patient.id], [t.sex, patient.sex === 'female' ? t.female : t.male], [t.dateOfBirth, patient.dateOfBirth ? new Date(patient.dateOfBirth).toLocaleDateString() : t.notProvided], [t.estimatedAge, patient.estimatedAge ?? t.notProvided], [t.registered, new Date(patient.registeredAt).toLocaleString()]].map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 break-all text-sm text-slate-800">{value}</dd></div>)}</dl><p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">{t.identityOnlyNotice}</p></Panel>}</>;
}
