import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { AccountUser, SessionResponse } from "../shared/accounts.js";
import { LoginScreen } from "./room/LoginScreen.js";
import { Room } from "./room/Room.js";
import { useMobileLayout } from "./mobile-layout.js";

export function App() {
  const isMobile = useMobileLayout();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [issue, setIssue] = useState("");
  const returnRoute = useRef(window.location.hash && !window.location.hash.startsWith("#/login") ? window.location.hash : "#/home");
  const loadSession = useCallback(async () => {
    const next = await api.me();
    if (next.user.mustChangePassword) { setSession(null); setIssue("first-use"); return; }
    setSession(next); setIssue("");
    if (window.location.hash.startsWith("#/login")) window.location.hash = !next.directory.configured && next.user.role === "admin" ? "#/setup" : returnRoute.current;
  }, []);
  useEffect(() => {
    let active = true;
    void api.me(undefined, false).then((next) => {
      if (!active) return;
      if (next.user.mustChangePassword) { setIssue("first-use"); window.location.hash = "/login"; }
      else { setSession(next); if (window.location.hash.startsWith("#/login")) window.location.hash = returnRoute.current; }
    }).catch((error) => {
      if (!active) return;
      if (!(error instanceof ApiError && error.status === 401)) setIssue("offline");
      window.location.hash = "/login";
    }).finally(() => { if (active) setLoading(false); });
    const expired = () => {
      if (!window.location.hash.startsWith("#/login")) returnRoute.current = window.location.hash;
      setSession(null); setIssue("expired"); window.location.hash = "/login";
    };
    window.addEventListener("music:session-expired", expired);
    return () => { active = false; window.removeEventListener("music:session-expired", expired); };
  }, []);
  async function logout(reason = "signed-out") {
    try { if (reason !== "password-changed") await api.logout(); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) { throw error; } }
    returnRoute.current = "#/home"; setSession(null); setIssue(reason); window.location.hash = `/login?reason=${reason}`;
  }
  if (loading) return <main className="login-screen"><div className="login-content" role="status"><span className="login-kicker">PRIVATE MUSIC SPACE</span><h1>正在连接音乐室</h1></div></main>;
  if (!session) return <LoginScreen isMobile={isMobile} issue={issue} onSuccess={loadSession} onDemo={() => { document.querySelector<HTMLDetailsElement>(".login-account-help")?.setAttribute("open", ""); }} />;
  return <Room key={session.user.id} session={session} onUserChange={(user: AccountUser) => setSession((value) => value ? { ...value, user } : value)} onLogout={logout} />;
}
