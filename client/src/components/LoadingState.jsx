import { useLanguage } from '../context/LanguageContext.jsx';

export default function LoadingState() {
  const { t } = useLanguage();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-sm">
        <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-700" aria-hidden="true" />
        {t.loading}
      </div>
    </div>
  );
}
