import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, type Me } from "./api";
import { App } from "./App";
import { Login } from "./Login";
import { useDemoBoard } from "./useBoard";
import { useServerBoard } from "./useServerBoard";
import "./styles.css";

// The shareable preview (VITE_DEMO=1) plans sample loads in the browser; the
// real app signs in and reads everything from the server.
const DEMO = import.meta.env.VITE_DEMO === "1";

function DemoRoot() {
  return <App b={useDemoBoard()} />;
}

function ServerRoot() {
  const [me, setMe] = useState<Me | null | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(() => {
    api<Me>("/api/me").then(setMe).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setError(e instanceof Error ? e.message : "Couldn't reach the server");
    });
  }, []);
  useEffect(check, [check]);

  if (error) return <div className="auth"><p className="warn">{error}. <button className="link" onClick={() => { setError(null); check(); }}>Try again</button></p></div>;
  if (me === "loading") return null;
  if (!me) return <Login onSignedIn={check} />;
  return <SignedIn me={me} onSignedOut={() => setMe(null)} />;
}

function SignedIn({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const b = useServerBoard(onSignedOut);
  const signOut = () => void api("/api/auth/logout", { method: "POST", body: {} }).finally(onSignedOut);
  if (b.loading) return null;
  return <App b={b} account={{ me, signOut }} />;
}

createRoot(document.getElementById("root")!).render(DEMO ? <DemoRoot /> : <ServerRoot />);
