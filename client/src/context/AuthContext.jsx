import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { currentUserRequest, getSessionToken, loginRequest, patientLoginRequest, setSessionToken } from '../api/httpClient.js';

const AuthContext = createContext(null);

function readTokenExpiration(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) * 1000;
  } catch {
    return 0;
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => getSessionToken());
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(getSessionToken()));

  const clearSession = useCallback(() => {
    setSessionToken(null);
    setToken(null);
    setUser(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => clearSession();
    window.addEventListener('hospital-emr:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hospital-emr:unauthorized', onUnauthorized);
  }, [clearSession]);

  useEffect(() => {
    let active = true;
    const storedToken = getSessionToken();
    if (!storedToken) return () => { active = false; };

    if (readTokenExpiration(storedToken) <= Date.now()) {
      window.setTimeout(clearSession, 0);
      return () => { active = false; };
    }

    currentUserRequest()
      .then(({ data }) => {
        if (active) {
          setToken(storedToken);
          setUser(data.data);
        }
      })
      .catch(() => {
        if (active) clearSession();
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [clearSession]);

  useEffect(() => {
    if (!token) return undefined;
    const expiresAt = readTokenExpiration(token);
    if (!expiresAt) {
      window.setTimeout(clearSession, 0);
      return undefined;
    }
    const timeout = window.setTimeout(clearSession, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [token, clearSession]);

  const login = useCallback(async (credentials, patient = false) => {
    const response = await (patient ? patientLoginRequest(credentials) : loginRequest(credentials));
    const { token: nextToken, user: nextUser } = response.data.data;
    setSessionToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
    return nextUser;
  }, []);

  const logout = useCallback(() => clearSession(), [clearSession]);
  const value = useMemo(() => ({ user, token, loading, isAuthenticated: Boolean(token && user), login, logout }), [user, token, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
