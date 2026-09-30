import { api } from "../api.js";
import { useState, type FormEvent } from "react";
import { AlertTriangle, ArrowRight, ChevronRight, Eye, EyeOff, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { LoginBackdrop } from "./LoginBackdrop.js";
import { validateAccountFields, type AccountField, type AccountUser } from "./account-state.js";
import { CapsLockNote, FieldLabel, FieldNote, useAccountFormFeedback } from "./AccountForm.js";

export function LoginScreen({ isMobile, initialUser, issue = "", onSuccess, onDemo }: { isMobile: boolean; initialUser?: AccountUser; issue?: string; onSuccess: (user: AccountUser) => void | Promise<void>; onDemo: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordUser, setPasswordUser] = useState<AccountUser | null>(initialUser?.mustChangePassword ? initialUser : null);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(issue === "invalid" ? "用户名或密码不正确，请重新输入。" : issue === "offline" ? "暂时连接不到音乐室，请检查网络后重试。" : issue === "disabled" ? "这个账号已停用，请联系音乐室管理员。" : "");
  const [credentialsRejected, setCredentialsRejected] = useState(issue === "invalid");
  const issues = validateAccountFields(passwordUser ? "first-password" : "login", { username, password: passwordUser ? newPassword : password, confirmation, currentPassword: password });
  const feedback = useAccountFormFeedback(issues);
  function changeField(field: AccountField, update: () => void) {
    update(); feedback.change(field); setError(""); setCredentialsRejected(false);
  }
  function fieldProps(field: AccountField) {
    const props = feedback.inputProps(field);
    const rejected = credentialsRejected && !passwordUser && (field === "username" || field === "password");
    return { ...props, "aria-invalid": props["aria-invalid"] || rejected, "aria-describedby": `${props["aria-describedby"]}${rejected ? " login-error" : ""}` };
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(""); setCredentialsRejected(false);
    if (!feedback.validate()) return;
    setBusy(true);
    try {
      if (passwordUser) { const result = await api.password(password, newPassword); await onSuccess(result.user); return; }
      const result = await api.login(username.trim(), password);
      if (result.user.mustChangePassword) { feedback.reset(); setPasswordUser(result.user); setShowPassword(false); feedback.focus("password"); return; }
      await onSuccess(result.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时连接不到音乐室，请稍后重试。");
      setCredentialsRejected(!passwordUser && (reason as { status?: number })?.status === 401);
    } finally { setBusy(false); }
  }

  return <main data-login-issue={issue} className={`login-screen ${isMobile ? "is-mobile" : ""} ${busy ? "is-busy" : ""}`}>
    <LoginBackdrop />
    <section className="login-content" aria-labelledby="login-title">
      <div className="login-brand"><img src="/favicon.svg" alt="" /><span>开听</span><small>PRIVATE MUSIC SPACE</small></div>
      <div className="login-copy"><span className="login-kicker">{passwordUser ? "MAKE IT YOURS" : "WELCOME BACK"}</span><h1 id="login-title">{passwordUser ? "让账号，只属于你" : "欢迎回到开听"}</h1><p>{passwordUser ? `你好，${passwordUser.displayName}` : "登录私人音乐空间"}</p></div>
      {passwordUser && <p className="login-required-note" role="status">首次登录或密码重置后，请先设置自己的密码。</p>}
      {!passwordUser && ["expired", "signed-out", "password-changed"].includes(issue) && <p className="login-session-note" role="status">{issue === "expired" ? "登录已过期，重新登录后会回到刚才的页面。" : issue === "password-changed" ? "密码已更新，所有设备已退出。请使用新密码登录。" : "你已退出音乐室，收藏和歌单已保留。"}</p>}
      <form ref={feedback.formRef} className="login-form" onSubmit={submit} noValidate aria-busy={busy}>
        {!passwordUser && <div className="login-form-field">
          <FieldLabel htmlFor={feedback.id("username")}>用户名</FieldLabel>
          <div className="login-field"><UserRound aria-hidden="true" /><input {...fieldProps("username")} required value={username} onChange={(event) => changeField("username", () => setUsername(event.target.value))} placeholder="输入用户名" autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} /></div>
          <FieldNote id={feedback.noteId("username")} hint="使用管理员分配的用户名，不区分大小写。" error={feedback.message("username")} />
        </div>}
        <div className="login-form-field">
          <FieldLabel htmlFor={feedback.id("password")}>{passwordUser ? "新密码" : "登录密码"}</FieldLabel>
          <div className="login-field"><LockKeyhole aria-hidden="true" /><input {...fieldProps("password")} required value={passwordUser ? newPassword : password} onChange={(event) => changeField("password", () => passwordUser ? setNewPassword(event.target.value) : setPassword(event.target.value))} type={showPassword ? "text" : "password"} placeholder={passwordUser ? "设置自己的密码" : "输入登录密码"} autoComplete={passwordUser ? "new-password" : "current-password"} disabled={busy} /><button type="button" className="login-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} aria-controls={passwordUser ? `${feedback.id("password")} ${feedback.id("confirmation")}` : feedback.id("password")} disabled={busy} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff /> : <Eye />}</button></div>
          <FieldNote id={feedback.noteId("password")} hint={passwordUser ? "8–64 个字符，区分大小写，不能与临时密码相同。" : "密码区分大小写，忘记密码请联系管理员。"} error={feedback.message("password")} success={passwordUser && feedback.interacted("password") && newPassword && !issues.password ? "密码格式符合要求。" : undefined} />
          <CapsLockNote visible={feedback.capsLockField === "password"} />
        </div>

        {passwordUser && <div className="login-form-field">
          <FieldLabel htmlFor={feedback.id("confirmation")}>确认新密码</FieldLabel>
          <div className="login-field"><LockKeyhole aria-hidden="true" /><input {...fieldProps("confirmation")} required type={showPassword ? "text" : "password"} value={confirmation} onChange={(event) => changeField("confirmation", () => setConfirmation(event.target.value))} placeholder="再次输入新密码" autoComplete="new-password" disabled={busy} /></div>
          <FieldNote id={feedback.noteId("confirmation")} hint="请与上方新密码保持一致。" error={feedback.message("confirmation")} success={feedback.interacted("confirmation") && confirmation && !issues.password && !issues.confirmation ? "两次输入一致。" : undefined} />
          <CapsLockNote visible={feedback.capsLockField === "confirmation"} />
        </div>}
        {error && <p id="login-error" className="login-error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
        <button className="login-submit" type="submit" disabled={busy}>{busy && <LoaderCircle className="login-spinner" aria-hidden="true" />}<span>{busy ? passwordUser ? "正在更新密码…" : "正在连接音乐室…" : passwordUser ? "保存并进入音乐室" : issue === "offline" ? "重新连接并登录" : "登录"}</span><ArrowRight aria-hidden="true" /></button>
      </form>
      {passwordUser ? <button type="button" className="login-demo" disabled={busy} onClick={() => { feedback.reset(); setPasswordUser(null); setPassword(""); setNewPassword(""); setConfirmation(""); setError(""); setShowPassword(false); setCredentialsRejected(false); feedback.focus("username"); }}>返回登录</button> : <button type="button" className="login-demo" disabled={busy} onClick={onDemo}>登录帮助 <ChevronRight aria-hidden="true" /></button>}
      <p className="login-note">同一间音乐室，各自喜欢的声音。</p>
      <details className="login-account-help"><summary>账号与登录说明</summary><p>使用管理员分配的用户名和密码登录。首次使用的管理员用户名为 admin，密码由部署时配置。忘记密码请联系音乐室管理员。</p></details>

    </section>
  </main>;
}
