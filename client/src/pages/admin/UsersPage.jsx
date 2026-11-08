import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { adminApi, responseData } from '../../api/adminApi.js';
import { ConfirmButton, Field, LoadingRows, Notice, PageTitle, Pagination, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

const provisionableRoles = ['receptionist', 'doctor', 'lab_technician', 'pharmacist', 'patient'];
const freshKey = () => crypto.randomUUID();

export function UsersPage() {
  const { t } = useLanguage();
  const [page, setPage] = useState(1); const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(null);
  const load = useCallback(async (selected = page) => { setLoading(true); setError(null); try { setData(responseData(await adminApi.users({ page: selected, limit: 20 }))); } catch (e) { setError(e); } finally { setLoading(false); } }, [page]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load(page)); return () => { active = false; }; }, [load, page]);
  return <><PageTitle title={t.userManagement} description={t.userManagementDescription} action={<Link className="btn-primary" to="/admin/users/new">{t.createUser}</Link>} /><Notice error={error} onRetry={() => load(page)} /><Panel title={t.userAccounts}>{loading ? <LoadingRows /> : <Table rows={data?.users || []} empty={t.noUsers} columns={[
    { key: 'fullName', label: t.name, render: (row) => <Link className="font-semibold text-blue-700 hover:underline" to={`/admin/users/${row.id}`}>{row.fullName}</Link> },
    { key: 'username', label: t.username }, { key: 'role', label: t.role, render: (row) => t.roleNames[row.role] || row.role },
    { key: 'isActive', label: t.status, render: (row) => <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{row.isActive ? t.active : t.inactive}</span> },
    { key: 'createdAt', label: t.created, render: (row) => new Date(row.createdAt).toLocaleDateString() }
  ]} />}<Pagination value={data?.pagination} onChange={(next) => setPage(next)} /></Panel></>;
}

export function UserDetailsPage() {
  const { id } = useParams(); const { t } = useLanguage();
  const [user, setUser] = useState(null); const [error, setError] = useState(null); const [loading, setLoading] = useState(true);
  const statusKey = useRef(freshKey());
  const load = useCallback(async () => { setLoading(true); setError(null); try { setUser(responseData(await adminApi.user(id))); } catch (e) { setError(e); } finally { setLoading(false); } }, [id]);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);
  async function updateStatus() { setError(null); try { setUser(responseData(await adminApi.setUserStatus(id, { isActive: !user.isActive, idempotencyKey: statusKey.current }))); statusKey.current = freshKey(); } catch (e) { setError(e); } }
  return <><PageTitle title={t.userDetails} action={<Link className="btn-secondary" to="/admin/users">{t.backToUsers}</Link>} /><Notice error={error} onRetry={load} />{loading ? <LoadingRows /> : user && <Panel title={user.fullName} action={<ConfirmButton confirmText={user.isActive ? t.confirmDeactivate : t.confirmActivate} onConfirm={updateStatus}>{user.isActive ? t.deactivate : t.activate}</ConfirmButton>}><dl className="grid gap-5 sm:grid-cols-2">{[[t.username, user.username], [t.role, t.roleNames[user.role] || user.role], [t.status, user.isActive ? t.active : t.inactive], [t.created, new Date(user.createdAt).toLocaleString()], [t.updated, new Date(user.updatedAt).toLocaleString()], ...(user.patient ? [[t.linkedPatient, user.patient]] : [])].map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 break-all text-sm text-slate-800">{value}</dd></div>)}</dl><p className="mt-5 text-xs text-slate-500">{t.userProfileLimited}</p></Panel>}</>;
}

export function CreateUserPage() {
  const { t } = useLanguage(); const navigate = useNavigate();
  const idempotencyKey = useRef(freshKey());
  const [form, setForm] = useState({ fullName: '', username: '', password: '', role: 'receptionist', patient: '', phone: '' });
  const [error, setError] = useState(null); const [saving, setSaving] = useState(false); const [partialSuccess, setPartialSuccess] = useState(false);
  function change(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  async function submit(event) {
    event.preventDefault(); setError(null);
    if (form.fullName.trim().length < 2 || form.username.trim().length < 3 || !form.password.trim()) { setError({ apiError: { message: t.formValidation } }); return; }
    if (form.role === 'patient' && !/^[a-f\d]{24}$/i.test(form.patient.trim())) { setError({ apiError: { message: t.patientIdRequired } }); return; }
    setSaving(true);
    try { const payload = { fullName: form.fullName, username: form.username, password: form.password, role: form.role, idempotencyKey: idempotencyKey.current, ...(form.phone.trim() ? { phone: form.phone.trim() } : {}), ...(form.role === 'patient' ? { patient: form.patient.trim() } : {}) }; const created = responseData(await adminApi.createUser(payload)); navigate(`/admin/users/${created.id}`, { replace: true }); }
    catch (e) { setError(e); if (e.apiError?.partialSuccess) setPartialSuccess(true); else idempotencyKey.current = freshKey(); } finally { setSaving(false); }
  }
  return <><PageTitle title={t.createUser} description={t.createUserDescription} action={<Link className="btn-secondary" to="/admin/users">{t.backToUsers}</Link>} /><Notice error={error} />{partialSuccess && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{t.partialCreateHint} <Link className="font-semibold underline" to="/admin/users">{t.checkUsers}</Link></p>}<Panel title={t.accountDetails}><form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate><Field disabled={partialSuccess} label={t.fullName} name="fullName" required minLength={2} maxLength={100} autoComplete="name" value={form.fullName} onChange={change} /><Field disabled={partialSuccess} label={t.username} name="username" required minLength={3} maxLength={30} autoComplete="off" value={form.username} onChange={change} /><Field disabled={partialSuccess} label={t.password} name="password" type="password" required autoComplete="new-password" value={form.password} onChange={change} /><label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.role}</span><select disabled={partialSuccess} className="form-input block w-full" name="role" value={form.role} onChange={change}>{provisionableRoles.map((role) => <option value={role} key={role}>{t.roleNames[role]}</option>)}</select></label>{form.role === 'patient' && <Field disabled={partialSuccess} label={t.linkedPatientId} name="patient" required value={form.patient} onChange={change} placeholder={t.objectIdPlaceholder} />}<Field disabled={partialSuccess} label={t.phoneOptional} name="phone" maxLength={30} value={form.phone} onChange={change} /><div className="sm:col-span-2"><p className="text-xs text-slate-500">{t.adminProvisioningLimit}</p>{!partialSuccess && <button className="btn-primary mt-5" type="submit" disabled={saving}>{saving ? t.saving : t.createUser}</button>}</div></form></Panel></>;
}
