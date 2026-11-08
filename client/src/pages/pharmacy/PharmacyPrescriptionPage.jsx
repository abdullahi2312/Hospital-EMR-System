import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { pharmacyApi } from '../../api/pharmacyApi.js';
import { EmptyState, Field, LoadingRows, Notice, PageTitle, Panel, Table } from '../../components/AdminUi.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function PharmacyPrescriptionPage() {
  const { id } = useParams();
  const { t, language } = useLanguage();
  const [prescription, setPrescription] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [selectedInventory, setSelectedInventory] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inventoryError, setInventoryError] = useState(null);
  const [dispenseError, setDispenseError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const numberFormat = new Intl.NumberFormat(language === 'so' ? 'so-SO' : 'en-US');
  const dateFormat = new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await pharmacyApi.prescription(id);
      const nextPrescription = response.data.data;
      setPrescription(nextPrescription);
      if (nextPrescription.medication?.id) {
        setInventoryError(null);
        try {
          const inventoryResponse = await pharmacyApi.inventory(nextPrescription.medication.id);
          const batches = inventoryResponse.data.data.inventory || [];
          setInventory(batches);
          setSelectedInventory((current) => batches.some((batch) => batch.id === current) ? current : '');
        } catch (inventoryRequestError) {
          setInventory([]);
          setInventoryError(inventoryRequestError);
        }
      } else {
        setInventory([]);
        setInventoryError({ apiError: { message: t.legacyPrescriptionInventoryGap } });
      }
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, t.legacyPrescriptionInventoryGap]);
  useEffect(() => { Promise.resolve().then(() => load()); }, [load]);

  const submit = async (operation) => {
    setSubmitting(true);
    setDispenseError(null);
    setSuccess(null);
    try {
      const result = await pharmacyApi.dispense(operation.prescriptionId, operation.body);
      setSuccess(result.data.message);
      setUncertain(null);
      setQuantity('');
      await load(true);
    } catch (requestError) {
      setDispenseError(requestError);
      const apiError = requestError?.apiError;
      if (apiError?.partialSuccess || apiError?.isNetworkError ||
          (apiError?.status === 503 && apiError?.data?.transactionUnavailable !== true)) setUncertain(operation);
    } finally {
      setSubmitting(false);
    }
  };

  const dispense = (event) => {
    event.preventDefault();
    const amount = Number(quantity);
    if (!selectedInventory || !Number.isFinite(amount) || amount <= 0 || amount > prescription.remainingQuantity) {
      setDispenseError({ apiError: { message: t.dispenseQuantityValidation } });
      return;
    }
    setUncertain(null);
    submit({
      prescriptionId: prescription.id,
      body: { inventoryId: selectedInventory, quantity: amount, ...(notes.trim() ? { notes: notes.trim() } : {}), idempotencyKey: createIdempotencyKey() }
    });
  };

  const selectedBatch = inventory.find((batch) => batch.id === selectedInventory);

  return <>
    <PageTitle title={t.prescriptionDetails} description={t.pharmacyDetailDescription} action={<div className="flex gap-2"><button className="btn-secondary" type="button" disabled={refreshing} onClick={() => load(true)}>{refreshing ? t.refreshing : t.refreshStatus}</button><Link className="btn-secondary" to="/pharmacy">{t.backToQueue}</Link></div>} />
    <Notice error={error} onRetry={() => load()} />
    {loading ? <LoadingRows /> : !prescription ? <EmptyState>{t.prescriptionNotFound}</EmptyState> : <div className="space-y-5">
      <Panel title={t.prescriptionDetails}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div><p className="text-xs font-medium uppercase text-slate-500">{t.pharmacyPatient}</p><p className="mt-1 font-semibold text-slate-900">{prescription.patient?.mrn || '—'}</p><p className="text-sm text-slate-600">{[prescription.patient?.firstName, prescription.patient?.fatherName, prescription.patient?.grandfatherName].filter(Boolean).join(' ')}</p></div>
          <div><p className="text-xs font-medium uppercase text-slate-500">{t.pharmacyEncounter}</p><p className="mt-1 font-semibold text-slate-900">{prescription.encounter?.visitNumber || '—'}</p></div>
          <div><p className="text-xs font-medium uppercase text-slate-500">{t.prescribingDoctor}</p><p className="mt-1 font-semibold text-slate-900">{prescription.doctor?.fullName || '—'}</p></div>
          <div><p className="text-xs font-medium uppercase text-slate-500">{t.pharmacyMedication}</p><p className="mt-1 font-semibold text-slate-900">{prescription.medication?.name} {prescription.medication?.strength || ''}</p><p className="text-sm text-slate-600">{prescription.dose} · {t[`pharmacyRoute_${prescription.route}`] || prescription.route}</p></div>
          <div><p className="text-xs font-medium uppercase text-slate-500">{t.frequencyAndDuration}</p><p className="mt-1 font-semibold text-slate-900">{prescription.frequency}</p><p className="text-sm text-slate-600">{numberFormat.format(prescription.duration)} {t.days}</p></div>
          <div><p className="text-xs font-medium uppercase text-slate-500">{t.dispensingStatus}</p><p className="mt-1"><span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800">{t[`pharmacyStatus_${prescription.status}`] || prescription.status}</span></p><p className="mt-2 text-sm text-slate-600">{t.prescribedQuantity}: {numberFormat.format(prescription.quantity)} · {t.alreadyDispensed}: {numberFormat.format(prescription.alreadyDispensed)} · {t.remainingQuantity}: <strong>{numberFormat.format(prescription.remainingQuantity)}</strong></p></div>
        </div>
      </Panel>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Panel title={t.dispensingHistory}>
          <Table rows={prescription.dispensingHistory || []} empty={t.noDispensingHistory} columns={[
            { key: 'id', label: t.dispenseRecord, render: (row) => row.id },
            { key: 'quantityDispensed', label: t.dispensedQuantity, render: (row) => `${numberFormat.format(row.quantityDispensed)} ${row.unit}` },
            { key: 'dispensedAt', label: t.dispensedAt, render: (row) => dateFormat.format(new Date(row.dispensedAt)) }
          ]} />
        </Panel>
        <Panel title={t.dispensePrescription}>
          <Notice error={inventoryError} onRetry={() => load(true)} />
          <Notice error={dispenseError} />
          {success && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">{success} · {t.prescriptionStatusRefreshed}</div>}
          {uncertain && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert"><p>{t.dispensePartialHelp}</p><button className="mt-2 font-semibold underline" type="button" disabled={submitting} onClick={() => submit(uncertain)}>{submitting ? t.loadingData : t.retrySameDispense}</button></div>}
          {!prescription.canDispense ? <p className="text-sm text-slate-500">{prescription.remainingQuantity <= 0 ? t.noRemainingQuantity : prescription.medication?.id ? t.prescriptionNotDispensable : t.legacyPrescriptionInventoryGap}</p> : inventory.length === 0 ? <EmptyState>{t.noInventoryBatches}</EmptyState> : <form className="space-y-4" onSubmit={dispense}>
            <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.inventoryBatch}</span><select required value={selectedInventory} onChange={(event) => setSelectedInventory(event.target.value)} disabled={Boolean(uncertain)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"><option value="">{t.selectInventoryBatch}</option>{inventory.map((batch) => <option key={batch.id} value={batch.id}>{batch.batchNumber} · {numberFormat.format(batch.quantity)} {batch.unit} · {new Date(batch.expiryDate).toLocaleDateString(language === 'so' ? 'so-SO' : 'en-US')}</option>)}</select></label>
            {selectedBatch && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{t.stockOnHand}: {numberFormat.format(selectedBatch.quantity)} {selectedBatch.unit}{selectedBatch.quantity <= selectedBatch.minimumStock ? ` · ${t.lowStock}` : ''}</p>}
            <Field label={`${t.dispenseQuantity} (≤ ${numberFormat.format(prescription.remainingQuantity)})`} type="number" min="0.000001" step="any" max={prescription.remainingQuantity} required value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={Boolean(uncertain)} />
            <label className="block space-y-1.5 text-sm font-medium text-slate-700"><span>{t.dispenseNotes}</span><textarea className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" rows="2" maxLength="2000" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={Boolean(uncertain)} /></label>
            <button className="btn-primary" type="submit" disabled={submitting || Boolean(uncertain) || !selectedInventory}>{submitting ? t.loadingData : t.submitDispense}</button>
          </form>}
        </Panel>
      </div>
    </div>}
  </>;
}
