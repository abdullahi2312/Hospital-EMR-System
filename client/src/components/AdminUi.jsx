import { useLanguage } from '../context/LanguageContext.jsx';

export function PageTitle({ title, description, action }) {
  return <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>{action}</div>;
}

export function Panel({ title, action, children, className = '' }) {
  return <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}><div className="flex min-h-14 items-center justify-between gap-3 border-b border-slate-100 px-4 sm:px-5"><h2 className="text-sm font-semibold text-slate-800">{title}</h2>{action}</div><div className="p-4 sm:p-5">{children}</div></section>;
}

export function Notice({ error, onRetry }) {
  const { t } = useLanguage();
  if (!error) return null;
  const message = error?.apiError?.message || error?.response?.data?.message || t.requestFailed;
  return <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert"><span>{message}</span>{onRetry && <button className="font-semibold underline" onClick={onRetry}>{t.retry}</button>}</div>;
}

export function LoadingRows() {
  const { t } = useLanguage();
  return <div className="py-10 text-center text-sm text-slate-500" role="status">{t.loadingData}</div>;
}

export function EmptyState({ children }) {
  return <div className="py-10 text-center text-sm text-slate-500">{children}</div>;
}

export function Table({ columns, rows, rowKey = (row) => row.id, empty }) {
  return <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead><tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">{columns.map((column) => <th key={column.key} className="whitespace-nowrap px-3 py-3">{column.label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={columns.length}><EmptyState>{empty}</EmptyState></td></tr> : rows.map((row) => <tr key={rowKey(row)} className="text-slate-700">{columns.map((column) => <td key={column.key} className="whitespace-nowrap px-3 py-3">{column.render ? column.render(row) : row[column.key]}</td>)}</tr>)}</tbody></table></div>;
}

export function Pagination({ value, onChange }) {
  const { t } = useLanguage();
  if (!value || value.totalPages <= 1) return null;
  return <div className="mt-4 flex items-center justify-between gap-3 text-sm text-slate-500"><span>{t.pageOf.replace('{page}', value.page).replace('{total}', value.totalPages)} · {value.total} {t.records}</span><div className="flex gap-2"><button className="btn-secondary" disabled={value.page <= 1} onClick={() => onChange(value.page - 1)}>{t.previous}</button><button className="btn-secondary" disabled={value.page >= value.totalPages} onClick={() => onChange(value.page + 1)}>{t.next}</button></div></div>;
}

export function Field({ label, ...props }) {
  return <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{label}</span><input {...props} className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100 ${props.className || ''}`} /></label>;
}

export function ConfirmButton({ disabled, onConfirm, children, confirmText }) {
  const { t } = useLanguage();
  return <button type="button" disabled={disabled} onClick={() => { if (window.confirm(confirmText || t.confirmAction)) onConfirm(); }} className="text-sm font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50">{children}</button>;
}
