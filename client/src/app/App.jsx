import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { homeForRole } from '../utils/roles.js';
import AppShell from '../layouts/AppShell.jsx';
import RequireAuth from '../routes/RequireAuth.jsx';
import RequireRole from '../routes/RequireRole.jsx';
import LoginPage from '../pages/LoginPage.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';
import { NotFoundPage, UnauthorizedPage } from '../pages/SystemPages.jsx';
import AdminDashboardPage from '../pages/admin/AdminDashboardPage.jsx';
import { CreateUserPage, UserDetailsPage, UsersPage } from '../pages/admin/UsersPage.jsx';
import { PatientDetailsPage, PatientsPage } from '../pages/admin/PatientsPage.jsx';
import { AuditLogsPage } from '../pages/admin/AuditLogsPage.jsx';
import DepartmentsPage from '../pages/admin/DepartmentsPage.jsx';
import DoctorDashboardPage from '../pages/doctor/DoctorDashboardPage.jsx';
import DoctorEncounterPage from '../pages/doctor/DoctorEncounterPage.jsx';
import LabDashboardPage from '../pages/laboratory/LabDashboardPage.jsx';
import LabOrderPage from '../pages/laboratory/LabOrderPage.jsx';
import PharmacyDashboardPage from '../pages/pharmacy/PharmacyDashboardPage.jsx';
import PharmacyPrescriptionPage from '../pages/pharmacy/PharmacyPrescriptionPage.jsx';
import ReceptionistDashboardPage from '../pages/receptionist/ReceptionistDashboardPage.jsx';
import PatientRegistrationPage from '../pages/receptionist/PatientRegistrationPage.jsx';
import EncounterCreationPage from '../pages/receptionist/EncounterCreationPage.jsx';
import { PatientDirectoryPage, PatientIdentityPage } from '../pages/receptionist/PatientDirectoryPage.jsx';
import { PatientConsentsPage, PatientDashboardPage, PatientLabResultsPage, PatientPrescriptionsPage, PatientVisitsPage } from '../pages/patient/PatientPortalPages.jsx';

function HomeRedirect() {
  const { isAuthenticated, user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={isAuthenticated ? homeForRole(user.role) : '/login'} replace />;
}

const rolePages = [
  { path: 'admin', role: 'admin' },
  { path: 'receptionist', role: 'receptionist' },
  { path: 'doctor', role: 'doctor' },
  { path: 'laboratory', role: 'lab_technician' },
  { path: 'pharmacy', role: 'pharmacist' },
  { path: 'patient', role: 'patient' }
];

export default function App() {
  const { isAuthenticated } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <HomeRedirect /> : <LoginPage />} />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          {rolePages.map(({ path, role }) => (
            <Route key={role} element={<RequireRole allow={[role]} />}>
              {path === 'admin' ? <>
                <Route path="admin" element={<AdminDashboardPage />} />
                <Route path="admin/users" element={<UsersPage />} />
                <Route path="admin/users/new" element={<CreateUserPage />} />
                <Route path="admin/users/:id" element={<UserDetailsPage />} />
                <Route path="admin/patients" element={<PatientsPage />} />
                <Route path="admin/patients/:id" element={<PatientDetailsPage />} />
                <Route path="admin/departments" element={<DepartmentsPage />} />
                <Route path="admin/audit-logs" element={<AuditLogsPage />} />
                <Route path="admin/access-logs" element={<AuditLogsPage access />} />
              </> : path === 'receptionist' ? <>
                <Route path="receptionist" element={<ReceptionistDashboardPage />} />
                <Route path="receptionist/register" element={<PatientRegistrationPage />} />
                <Route path="receptionist/patients" element={<PatientDirectoryPage />} />
                <Route path="receptionist/patients/:id" element={<PatientIdentityPage />} />
                <Route path="receptionist/encounters/new" element={<EncounterCreationPage />} />
              </> : path === 'doctor' ? <>
                <Route path="doctor" element={<DoctorDashboardPage />} />
                <Route path="doctor/encounters/:id" element={<DoctorEncounterPage />} />
              </> : path === 'laboratory' ? <>
                <Route path="laboratory" element={<LabDashboardPage />} />
                <Route path="laboratory/orders/:orderId" element={<LabOrderPage />} />
              </> : path === 'pharmacy' ? <>
                <Route path="pharmacy" element={<PharmacyDashboardPage />} />
                <Route path="pharmacy/prescriptions/:id" element={<PharmacyPrescriptionPage />} />
              </> : path === 'patient' ? <>
                <Route path="patient" element={<PatientDashboardPage />} />
                <Route path="patient/visits" element={<PatientVisitsPage />} />
                <Route path="patient/lab-results" element={<PatientLabResultsPage />} />
                <Route path="patient/prescriptions" element={<PatientPrescriptionsPage />} />
                <Route path="patient/consents" element={<PatientConsentsPage />} />
              </> : <Route path={path} element={<DashboardPage />} />}
            </Route>
          ))}
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
