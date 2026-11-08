import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pharmacyApi } from '../../api/pharmacyApi.js';
import { LoadingRows, Notice, PageTitle, Panel, Pagination, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

export default function PharmacyDashboardPage() {
  const { t, language } = useLanguage();
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState({ prescriptions: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const numberFormat = new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US');

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await pharmacyApi.pendingPrescriptions({ page, limit: 20 });
      setQueue(response.data.data);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page]);
  useEffect(() => { Promise.resolve().then(() => load()); }, [load]);

  return <>
    <PageTitle title={t.pharmacyDashboard} description={t.pharmacyDashboardDescription} action={<button className="btn-secondary" type="button" onClick={() => load(true)} disabled={refreshing}>{refreshing ? t.refreshing : t.refreshQueue}</button>} />
    <Notice error={error} onRetry={() => load()} />
    <Panel title={t.pendingPrescriptionQueue}>
      {loading ? <LoadingRows /> : <Table rows={queue.prescriptions || []} empty={t.noPendingPrescriptions} columns={[
        { key: 'id', label: t.prescriptionId, render: (row) => <Link className="font-semibold text-blue-700 hover:underline" to={`/pharmacy/prescriptions/${row.id}`}>{row.id}</Link> },
        { key: 'patient', label: t.pharmacyPatient, render: (row) => <span><span className="block font-medium text-slate-800">{row.patient?.mrn || '—'}</span><span className="text-xs text-slate-500">{[row.patient?.firstName, row.patient?.fatherName, row.patient?.grandfatherName].filter(Boolean).join(' ')}</span></span> },
        { key: 'encounter', label: t.pharmacyEncounter, render: (row) => row.encounter?.visitNumber || '—' },
        { key: 'doctor', label: t.prescribingDoctor, render: (row) => row.doctor?.fullName || '—' },
        { key: 'medication', label: t.pharmacyMedication, render: (row) => <span><span className="block font-medium">{row.medication?.name}</span><span className="text-xs text-slate-500">{row.dose} · {t[`pharmacyRoute_${row.route}`] || row.route}</span></span> },
        { key: 'status', label: t.status, render: (row) => <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{t[`pharmacyStatus_${row.status}`] || row.status}</span> },
        { key: 'remainingQuantity', label: t.remainingQuantity, render: (row) => numberFormat.format(row.remainingQuantity) },
        { key: 'open', label: t.openPrescription, render: (row) => <Link className="btn-secondary" to={`/pharmacy/prescriptions/${row.id}`}>{t.openPrescription}</Link> }
      ]} />}
      {!loading && <Pagination value={queue.pagination} onChange={setPage} />}
    </Panel>
  </>;
}
