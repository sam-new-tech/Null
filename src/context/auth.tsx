import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface AuthContextValue {
  connected: boolean;
  login: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  connected: false,
  login: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);

  const login = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    setConnected(true);
  }, []);

  const logout = useCallback(() => {
    setConnected(false);
  }, []);

  return <AuthContext.Provider value={{ connected, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
