export const ROLE_HOME = {
  admin: '/admin',
  receptionist: '/receptionist',
  doctor: '/doctor',
  lab_technician: '/laboratory',
  pharmacist: '/pharmacy',
  patient: '/patient'
};

export const ROLE_LABEL = {
  admin: 'Administrator',
  receptionist: 'Reception',
  doctor: 'Doctor',
  lab_technician: 'Laboratory',
  pharmacist: 'Pharmacy',
  patient: 'Patient'
};

export function homeForRole(role) {
  return ROLE_HOME[role] || '/login';
}
