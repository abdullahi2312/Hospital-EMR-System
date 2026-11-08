import { useLanguage } from '../context/LanguageContext.jsx';

export default function LanguageToggle() {
  const { language, changeLanguage, t } = useLanguage();
  return (
    <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
      <span className="sr-only">{t.language}</span>
      <select
        value={language}
        onChange={(event) => changeLanguage(event.target.value)}
        className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
        aria-label={t.language}
      >
        <option value="en">English</option>
        <option value="so">Soomaali</option>
      </select>
    </label>
  );
}
