import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function RequireRole({ allow }) {
  const { user } = useAuth();
  return user && allow.includes(user.role) ? <Outlet /> : <Navigate to="/unauthorized" replace />;
}
