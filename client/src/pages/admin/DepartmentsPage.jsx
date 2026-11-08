import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../../api/adminApi.js';
import { EmptyState, Field, LoadingRows, Notice, PageTitle, Panel } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export default function DepartmentsPage() {
  const { language, t } = useLanguage();
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ name: '', code: '', description: '' });
  const [saving, setSaving] = useState(false);
  const copy = language === 'so'
    ? { description: 'Ku dar waax firfircoon oo loo isticmaali karo samaynta booqashooyinka.', name: 'Magaca waaxda', code: 'Koodhka waaxda', detail: 'Sharaxaad (ikhtiyaari)', add: 'Ku dar waax', active: 'Waaxyaha firfircoon', empty: 'Waax firfircoon lama helin.', saved: 'Waaxda waa la daray.', validation: 'Geli magaca iyo koodh sax ah.', retry: 'Dib u tijaabi' }
    : { description: 'Add an active department that reception can select when creating encounters.', name: 'Department name', code: 'Department code', detail: 'Description (optional)', add: 'Add department', active: 'Active departments', empty: 'No active departments found.', saved: 'Department added.', validation: 'Enter a valid department name and code.', retry: 'Retry' };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const result = await adminApi.departments(); setDepartments(result.data.data?.departments || []); }
    catch (requestError) { setError(requestError); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { let active = true; Promise.resolve().then(() => active && load()); return () => { active = false; }; }, [load]);

  async function submit(event) {
    event.preventDefault(); setError(null); setNotice('');
    if (!form.name.trim() || !/^[A-Za-z0-9_-]{1,30}$/.test(form.code.trim()) || form.name.trim().length > 100 || form.description.length > 1000) {
      setError({ apiError: { message: copy.validation } }); return;
    }
    setSaving(true);
    try { await adminApi.createDepartment({ name: form.name.trim(), code: form.code.trim().toUpperCase(), ...(form.description.trim() ? { description: form.description.trim() } : {}) }); setForm({ name: '', code: '', description: '' }); setNotice(copy.saved); await load(); }
    catch (requestError) { setError(requestError); if (requestError.apiError?.partialSuccess) await load(); }
    finally { setSaving(false); }
  }

  return <>
    <PageTitle title={t.departmentManagement} description={copy.description} action={<Link className="btn-secondary" to="/admin">{t.dashboard}</Link>} />
    {error && <Notice error={error} onRetry={load} />}
    {notice && <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">{notice}</p>}
    <Panel title={copy.add}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={copy.name} maxLength={100} required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        <Field label={copy.code} maxLength={30} required value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} />
        <label className="block space-y-1.5 text-sm font-medium text-slate-700 sm:col-span-2"><span>{copy.detail}</span><textarea className="form-input block min-h-20 w-full" maxLength={1000} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
        <div className="sm:col-span-2"><button className="btn-primary" disabled={saving} type="submit">{saving ? t.saving : copy.add}</button></div>
      </form>
    </Panel>
    <Panel className="mt-5" title={copy.active}>
      {loading ? <LoadingRows /> : departments.length === 0 ? <EmptyState>{copy.empty}</EmptyState> : <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">{copy.name}</th><th className="px-3 py-2">{copy.code}</th></tr></thead><tbody className="divide-y divide-slate-100">{departments.map((department) => <tr key={department.id}><td className="px-3 py-3 font-medium text-slate-800">{department.name}</td><td className="px-3 py-3 font-mono text-slate-600">{department.code}</td></tr>)}</tbody></table></div>}
    </Panel>
  </>;
}
