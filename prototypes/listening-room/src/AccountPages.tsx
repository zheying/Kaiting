import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronRight, Copy, Eye, EyeOff, FolderOpen, Headphones, Heart, KeyRound, ListMusic, LoaderCircle, LockKeyhole, LogOut, Monitor, Pencil, Plus, Search, ShieldCheck, ShieldOff, Smartphone, UserRound, Users, X } from "lucide-react";
import { accountChangeIssue, characterCount, generateTemporaryPassword, roleLabel, validateAccountFields, type AccountField, type AccountFormMode, type AccountRole, type AccountSession, type AccountUser } from "./account-state";
import { CapsLockNote, FieldLabel, FieldNote, useAccountFormFeedback } from "./AccountForm";
import { AccountFilter, type AccountFilterValue } from "./AccountFilter";

type AccountDialogState = { type: "profile" | "password" | "create" | "manage" | "toggle" | "reset" | "session" | "logout"; user?: AccountUser; session?: AccountSession } | { type: "created"; user: AccountUser; temporaryPassword: string } | null;
type Props = {
  user: AccountUser | undefined;
  users: AccountUser[];
  sessions: AccountSession[];
  view: "profile" | "security" | "users" | "denied";
  scene?: string;
  favoriteCount: number;
  playlistCount: number;
  onUserChange: (user: AccountUser) => void;
  onCreate: (user: AccountUser) => void;
  onRevoke: (ids: string[]) => void;
  onNavigate: (route: string) => void;
  onLogin: () => void;
  onLogout: (reason?: string) => void;
  onDirectory: () => void;
  onNotice: (message: string) => void;
};

function AccountDialog({ title, onClose, children, success = false }: { title: string; onClose: () => void; children: ReactNode; success?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="standard-dialog account-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-heading"><span className={`dialog-symbol ${success ? "account-success-symbol" : ""}`}>{success ? <Check /> : <UserRound />}</span><button type="button" className="icon-button" aria-label="关闭账号对话框" onClick={onClose}><X /></button></div>
    <h2>{title}</h2>{children}
  </dialog>;
}

function CreatedAccountDetails({ user, password, onClose }: { user: AccountUser; password: string; onClose: () => void }) {
  const passwordId = useId();
  const [visible, setVisible] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  async function copyLogin() {
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(`开听登录信息\n用户名：${user.username}\n临时密码：${password}\n首次登录后请修改密码。`);
      setCopyState("copied");
    } catch { setCopyState("failed"); }
  }
  return <>
    <p>「{user.displayName}」现在可以加入音乐室了。请将以下登录信息交给对方。</p>
    <dl className="account-created-summary"><div><dt>用户名</dt><dd>{user.username}</dd></div><div><dt>账号角色</dt><dd>{roleLabel(user.role)}</dd></div></dl>
    <div className="account-generated-password">
      <div className="account-generated-heading"><label htmlFor={passwordId}>临时密码</label><span>{password.length} 位 · 自动生成</span></div>
      <div className="account-generated-value"><input id={passwordId} type={visible ? "text" : "password"} readOnly value={password} autoComplete="off" spellCheck={false} aria-describedby={`${passwordId}-note`} onFocus={(event) => event.currentTarget.select()} /><button type="button" aria-label={visible ? "隐藏临时密码" : "显示临时密码"} aria-pressed={visible} aria-controls={passwordId} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff /> : <Eye />}</button></div>
    </div>
    <p className="account-credential-note" id={`${passwordId}-note`}><KeyRound aria-hidden="true" /><span>临时密码仅在此展示，请在关闭前复制保存。对方首次登录时需要设置自己的密码。</span></p>
    <p className={`account-copy-status ${copyState === "failed" ? "is-error" : ""}`} role="status">{copyState === "copied" ? "用户名与临时密码已复制。" : copyState === "failed" ? "复制失败，请显示密码后选中文字手动复制。" : ""}</p>
    <div className="dialog-actions"><button type="button" className="button subtle" onClick={onClose}>完成</button><button type="button" className="button primary" disabled={copyState === "copying"} onClick={copyLogin}>{copyState === "copied" ? <Check /> : <Copy />}{copyState === "copying" ? "正在复制…" : copyState === "copied" ? "已复制登录信息" : "复制登录信息"}</button></div>
  </>;
}

export function AccountAvatar({ user, large = false }: { user: AccountUser; large?: boolean }) {
  return <span className={`account-avatar ${user.color} ${large ? "large" : ""}`} aria-hidden="true">{Array.from(user.displayName)[0]}</span>;
}

export function AccountPages({ user, users, sessions, view, scene = "", favoriteCount, playlistCount, onUserChange, onCreate, onRevoke, onNavigate, onLogin, onLogout, onDirectory, onNotice }: Props) {
  const [dialog, setDialog] = useState<AccountDialogState>(scene === "account-save-error" ? { type: "profile" } : scene === "account-create" ? { type: "create" } : null);
  const [displayName, setDisplayName] = useState(scene === "account-create" ? "" : scene === "account-save-error" ? "听风" : user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [color, setColor] = useState<AccountUser["color"]>(user?.color ?? "rose");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<AccountRole>("member");
  const [grantConfirmed, setGrantConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(scene === "account-save-error");
  const [loadState, setLoadState] = useState<"ready" | "loading" | "error">(scene === "accounts-error" ? "error" : scene === "accounts-loading" ? "loading" : "ready");
  const [query, setQuery] = useState(scene === "accounts-empty" ? "未找到的用户" : "");
  const [filter, setFilter] = useState<AccountFilterValue>("all");
  const timer = useRef<number | null>(null);
  const loadTimer = useRef<number | null>(null);
  const formMode: AccountFormMode = dialog && ["profile", "password", "create", "manage", "reset"].includes(dialog.type) ? dialog.type as AccountFormMode : "profile";
  const grantRequired = role === "admin" && (dialog?.type === "create" || (dialog?.type === "manage" && dialog.user?.role !== "admin"));
  const issues = validateAccountFields(formMode, { username, displayName, bio, currentPassword, password, confirmation, grantConfirmed }, users, grantRequired);
  const feedback = useAccountFormFeedback(issues);
  function changeField(field: AccountField, update: () => void) { update(); feedback.change(field); setError(""); }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); if (loadTimer.current) window.clearTimeout(loadTimer.current); }, []);
  function close() { if (timer.current) window.clearTimeout(timer.current); feedback.reset(); setSaving(false); setSaveFailed(false); setError(""); setPassword(""); setCurrentPassword(""); setConfirmation(""); setDialog(null); }
  function open(next: Exclude<AccountDialogState, null>) {
    feedback.reset();
    const target = next.user ?? user;
    setDisplayName(next.type === "create" ? "" : target?.displayName ?? ""); setBio(target?.bio ?? ""); setColor(target?.color ?? "rose");
    setUsername(next.type === "create" ? "" : target?.username ?? ""); setRole(next.type === "create" ? "member" : target?.role ?? "member");
    setError(""); setSaveFailed(false); setPassword(""); setConfirmation(""); setCurrentPassword(""); setShowPassword(false); setGrantConfirmed(false); setDialog(next);
  }
  function save(apply: () => void, message: string, result?: Exclude<AccountDialogState, null>) {
    if (saving) return;
    setSaving(true); setError(""); setSaveFailed(false);
    timer.current = window.setTimeout(() => { apply(); close(); if (result) setDialog(result); onNotice(message); }, 650);
  }
  function retryLoad() { setLoadState("loading"); loadTimer.current = window.setTimeout(() => setLoadState("ready"), 650); }
  const isAdmin = user?.role === "admin";
  const otherSessions = sessions.filter((session) => !session.current);
  const filteredUsers = users.filter((item) => `${item.username} ${item.displayName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === "all" || (filter === "admin" ? item.role === "admin" : item.status === filter)));
  const heading = (title: string, description: string) => <header className="page-heading"><div><span className="eyebrow">开听 / {view === "users" ? "管理音乐室" : "我的账号"}</span><h1>{title}</h1><p>{description}</p></div>{view === "users" && isAdmin && <button className="button primary" onClick={() => open({ type: "create" })}><Plus />创建账号</button>}</header>;
  if (!user) return <div className="account-page">{heading("你的账号，你的音乐", "登录后，管理自己的资料与聆听空间。")}<section className="account-empty"><UserRound /><h2>先登录，再回到这里</h2><p>每个账号拥有各自的收藏、歌单与登录会话。</p><button className="button primary" onClick={onLogin}>前往登录</button></section></div>;
  if (view === "denied" || (view === "users" && !isAdmin)) return <div className="account-page">{heading("这个页面需要管理员权限", "你仍然可以继续聆听，管理自己的收藏与歌单。")}<section className="account-empty"><ShieldOff /><h2>这部分交给管理员</h2><p>用户管理和音乐目录设置仅对管理员开放。需要调整权限时，请联系音乐室管理员。</p><button className="button primary" onClick={() => onNavigate("account")}>回到我的账号</button></section></div>;

  function submitForm() {
    if (!user || !dialog || saving) return;
    setError("");
    if (!feedback.validate()) return;
    if (dialog.type === "profile") {
      save(() => onUserChange({ ...user, displayName: displayName.trim(), bio: bio.trim(), color }), "个人资料已更新");
    } else if (dialog.type === "password" || dialog.type === "reset") {
      if (dialog.type === "password" && currentPassword === "wrong") { feedback.setIssue("currentPassword", "当前密码不正确，请重新输入。"); return; }
      const target = dialog.user ?? user;
      if (dialog.type === "reset") { const denial = accountChangeIssue(user, users, target, {}); if (denial) { setError(denial); return; } }
      save(() => {
        onUserChange({ ...target, mustChangePassword: dialog.type === "reset", passwordUpdated: "刚刚" });
        if (dialog.type === "password") { onRevoke(otherSessions.map((session) => session.id)); onLogout("password-changed"); }
      }, dialog.type === "reset" ? "密码已重置，下次登录需要设置新密码" : "密码已更新，请重新登录");
    } else if (dialog.type === "create") {
      if (!isAdmin) { setError("只有管理员可以创建账号。"); return; }
      try {
        const temporaryPassword = generateTemporaryPassword();
        const created: AccountUser = { id: crypto.randomUUID(), username: username.trim().toLowerCase(), displayName: displayName.trim(), bio: "", color: "blue", role, status: "active", joined: "今天", lastSeen: "尚未登录", passwordUpdated: "刚刚", mustChangePassword: true };
        save(() => onCreate(created), `已创建 ${created.displayName}，首次登录需修改密码`, { type: "created", user: created, temporaryPassword });
      } catch { setError("未能生成临时密码，账号尚未创建，请重试。"); }
    } else if (dialog.type === "manage" && dialog.user) {
      const target = dialog.user;
      const issue = accountChangeIssue(user, users, target, { role });
      if (issue) { setError(issue); return; }
      save(() => onUserChange({ ...target, role, displayName: displayName.trim() }), "账号信息已更新");
    }
  }
  const passwordLabel = dialog?.type === "password" ? "新密码" : "临时密码";
  const passwordFields = <>
    {dialog?.type === "password" && <div className="form-field">
      <FieldLabel htmlFor={feedback.id("currentPassword")}>当前密码</FieldLabel>
      <input {...feedback.inputProps("currentPassword")} type="password" required autoComplete="current-password" value={currentPassword} onChange={(event) => changeField("currentPassword", () => setCurrentPassword(event.target.value))} />
      <FieldNote id={feedback.noteId("currentPassword")} hint="输入正在使用的密码；忘记密码请联系管理员。" error={feedback.message("currentPassword")} />
      <CapsLockNote visible={feedback.capsLockField === "currentPassword"} />
    </div>}
    <div className="form-field">
      <FieldLabel htmlFor={feedback.id("password")}>{passwordLabel}</FieldLabel>
      <span className="account-password-field"><input {...feedback.inputProps("password")} type={showPassword ? "text" : "password"} required autoComplete="new-password" placeholder={`设置${passwordLabel}`} value={password} onChange={(event) => changeField("password", () => setPassword(event.target.value))} /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} aria-controls={`${feedback.id("password")} ${feedback.id("confirmation")}`} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff /> : <Eye />}</button></span>
      <FieldNote id={feedback.noteId("password")} hint="8–64 个字符，区分大小写，不能全部为空格。" error={feedback.message("password")} success={feedback.interacted("password") && password && !issues.password ? "密码格式符合要求。" : undefined} />
      <CapsLockNote visible={feedback.capsLockField === "password"} />
    </div>
    <div className="form-field">
      <FieldLabel htmlFor={feedback.id("confirmation")}>确认密码</FieldLabel>
      <input {...feedback.inputProps("confirmation")} type={showPassword ? "text" : "password"} required autoComplete="new-password" placeholder={`再次输入${passwordLabel}`} value={confirmation} onChange={(event) => changeField("confirmation", () => setConfirmation(event.target.value))} />
      <FieldNote id={feedback.noteId("confirmation")} hint={`请与上方${passwordLabel}保持一致。`} error={feedback.message("confirmation")} success={feedback.interacted("confirmation") && confirmation && !issues.password && !issues.confirmation ? "两次输入一致。" : undefined} />
      <CapsLockNote visible={feedback.capsLockField === "confirmation"} />
    </div>
  </>;
  const roleFields = <div className="account-role-field"><span>账号角色</span><div className="account-role-options" role="group" aria-label="账号角色">{(["member", "admin"] as const).map((value) => <button type="button" aria-pressed={role === value} key={value} disabled={dialog?.type === "manage" && dialog.user?.id === user.id} onClick={() => { setRole(value); setGrantConfirmed(false); feedback.change("grantConfirmed"); setError(""); }}><span>{value === "admin" ? <ShieldCheck /> : <Headphones />}{roleLabel(value)}</span><small>{value === "admin" ? "管理目录与用户" : "聆听与私人收藏"}</small>{role === value && <Check />}</button>)}</div>{dialog?.user?.id === user.id ? <p>自己的角色由另一位管理员调整。</p> : <p>所有账号共享曲库，收藏与歌单各自独立。管理员不能查看他人的私人收藏和歌单。</p>}{grantRequired && <><label className="account-consent"><input {...feedback.inputProps("grantConfirmed")} type="checkbox" required checked={grantConfirmed} onChange={(event) => changeField("grantConfirmed", () => setGrantConfirmed(event.target.checked))} />确认允许此账号管理用户、音乐目录与扫描</label><FieldNote id={feedback.noteId("grantConfirmed")} hint="授予管理权限前，需要你的确认。" error={feedback.message("grantConfirmed")} /></>}</div>;
  const titles = { profile: "编辑个人资料", password: "修改登录密码", create: "邀请一个新的聆听者", created: "账号已创建", manage: "管理账号", toggle: dialog?.user?.status === "disabled" ? "重新启用这个账号？" : "停用这个账号？", reset: "重置登录密码", session: "退出其他设备？", logout: "暂别音乐室？" };

  return <div className="account-page">
    {heading(view === "users" ? "一起，把音乐留在这里" : view === "security" ? "安心回到你的音乐" : "属于你的，聆听空间", view === "users" ? "共享同一座曲库，每个人都有自己的喜欢。" : view === "security" ? "管理登录密码，以及仍在使用音乐室的设备。" : "照顾你的资料，也照顾每一份喜欢。")}
    <nav className="account-tabs" aria-label="账号页面"><a href="#/account" aria-current={view === "profile" ? "page" : undefined}>个人资料</a><a href="#/account/security" aria-current={view === "security" ? "page" : undefined}>登录与安全</a>{isAdmin && <a href="#/admin/users" aria-current={view === "users" ? "page" : undefined}>用户管理<span>{users.length}</span></a>}</nav>
    {view === "profile" && <>
      <section className="account-identity" aria-label="我的账号资料">
        <AccountAvatar user={user} large />
        <div className="account-identity-copy">
          <span className={`account-role ${user.role}`}>{isAdmin ? <ShieldCheck /> : <Headphones />}{roleLabel(user.role)}</span>
          <h2>{user.displayName}</h2>
          <p className="account-identity-meta"><span className="account-username">@{user.username}</span><span className="account-joined">加入于 {user.joined}</span></p>
          <p className="account-bio">{user.bio || "给自己留一句话，也给音乐留一点时间。"}</p>
        </div>
        <button className="button subtle" onClick={() => open({ type: "profile" })}><Pencil />编辑资料</button>
      </section>
      <section className="account-personal-library" aria-label="我的音乐"><a href="#/favorites"><Heart /><span><strong>{favoriteCount}</strong>首收藏歌曲</span><ChevronRight /></a><a href="#/playlists"><ListMusic /><span><strong>{playlistCount}</strong>张私人歌单</span><ChevronRight /></a><div><LockKeyhole /><p>你的喜欢，只属于你。<small>收藏与歌单跟随账号，其他用户不可见。</small></p></div></section>
      <section className="account-section"><div className="account-section-heading"><div><h2>在音乐室，你可以</h2><p>{isAdmin ? "照顾自己的音乐，也照顾这间音乐室。" : "专心聆听，目录与账号管理交给管理员。"}</p></div></div><div className="account-permissions"><div><Headphones /><span><strong>自由聆听</strong><small>浏览曲库、搜索音乐、创建待播清单</small></span><Check /></div><div><Heart /><span><strong>收藏喜欢的声音</strong><small>管理自己的收藏、私人歌单与排列顺序</small></span><Check /></div>{isAdmin ? <><button onClick={onDirectory}><FolderOpen /><span><strong>管理音乐目录</strong><small>连接目录、扫描文件与查看扫描结果</small></span><ChevronRight /></button><button onClick={() => onNavigate("admin/users")}><Users /><span><strong>管理音乐室成员</strong><small>创建账号、分配角色、管理账号状态</small></span><ChevronRight /></button></> : <div className="account-permission-note"><ShieldCheck /><span><strong>共享曲库，独立空间</strong><small>目录扫描与用户管理由管理员负责</small></span></div>}</div></section>
      <div className="account-signout"><span><span className="account-status-dot" />已登录 · @{user.username}</span><button className="text-button" onClick={() => open({ type: "logout" })}><LogOut />退出登录</button></div>
    </>}
    {view === "security" && <>
      <section className="account-section account-password-summary"><span className="account-section-icon"><KeyRound /></span><div><h2>登录密码</h2><p>上次更新 · {user.passwordUpdated}</p></div><button className="button subtle" onClick={() => open({ type: "password" })}>修改密码</button></section>
      <section className="account-section"><div className="account-section-heading"><div><h2>登录设备 <small>{sessions.length}</small></h2><p>退出不再使用的设备，不影响当前播放。</p></div><button className="text-button" disabled={!otherSessions.length} onClick={() => open({ type: "session" })}>退出其他设备</button></div><div className="account-session-list">{sessions.map((session) => <article key={session.id}>{session.mobile ? <Smartphone /> : <Monitor />}<div><strong>{session.name}{session.current && <span>当前设备</span>}</strong><p>{session.detail} · {session.lastSeen}</p></div>{!session.current && <button className="text-button" aria-label={`退出 ${session.name}`} onClick={() => open({ type: "session", session })}>退出</button>}</article>)}</div>{!otherSessions.length && <p className="account-inline-note"><Check />只有当前设备登录着你的账号。</p>}</section>
      <div className="account-security-note"><ShieldCheck /><p>修改密码后，所有设备都需要重新登录。<br />忘记密码时，请联系音乐室管理员重置。</p></div>
    </>}
    {view === "users" && <>
      <div className="account-user-summary"><span><strong>{users.length}</strong>个账号</span><span><strong>{users.filter((item) => item.status === "active").length}</strong>个可用</span><span><strong>{users.filter((item) => item.role === "admin").length}</strong>位管理员</span></div>
      <div className="account-user-toolbar"><label><Search /><input placeholder="搜索昵称或用户名" aria-label="搜索账号" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="清空账号搜索" onClick={() => setQuery("")}><X /></button>}</label><AccountFilter value={filter} onChange={setFilter} /></div>
      {loadState !== "ready" ? <div className="account-empty" role={loadState === "error" ? "alert" : "status"}>{loadState === "loading" ? <LoaderCircle className="button-spinner" /> : <AlertTriangle />}<h2>{loadState === "loading" ? "正在载入音乐室成员" : "账号列表暂时没有载入"}</h2><p>{loadState === "loading" ? "请稍候，正在读取账号信息。" : "连接暂时中断，已有账号和权限没有改变。"}</p>{(loadState === "error" || scene === "accounts-loading") && <button className="button subtle" onClick={retryLoad}>{loadState === "error" ? "重新载入" : "继续演示载入"}</button>}</div> : <>
        {filteredUsers.length > 0 && <div className="account-user-list" role="table" aria-label="音乐室账号"><div className="account-user-row account-user-head" role="row"><span role="columnheader">账号</span><span role="columnheader">角色</span><span role="columnheader">状态</span><span role="columnheader">最近访问</span><span role="columnheader">操作</span></div>{filteredUsers.map((item) => <div className="account-user-row" role="row" key={item.id}><div className="account-user-name" role="cell"><AccountAvatar user={item} /><span><strong>{item.displayName}{item.id === user.id && <em>你</em>}</strong><small>@{item.username}</small></span></div><div role="cell"><span className={`account-role ${item.role}`}>{roleLabel(item.role)}</span></div><div className={`account-user-status ${item.status}`} role="cell"><span />{item.status === "disabled" ? "已停用" : item.mustChangePassword ? "待首次登录" : "可用"}</div><span className="account-last-seen" role="cell">{item.lastSeen}</span><div role="cell"><button className="text-button" aria-label={`管理 ${item.displayName}`} onClick={() => open({ type: "manage", user: item })}>管理<ChevronRight /></button></div></div>)}</div>}
        {!filteredUsers.length && <div className="account-empty"><Search /><h2>没有找到匹配的账号</h2><p>换一个名字试试，或清除筛选查看所有成员。</p><button className="button subtle" onClick={() => { setQuery(""); setFilter("all"); }}>查看全部账号</button></div>}
      </>}
      <p className="account-inline-note"><ShieldCheck />音乐室始终保留至少一位可用的管理员。停用账号会结束其登录会话，个人收藏与歌单仍然保留。</p>
    </>}
    {dialog && <AccountDialog key={dialog.type} title={titles[dialog.type]} onClose={close} success={dialog.type === "created"}>
      {dialog.type === "created" ? <CreatedAccountDetails user={dialog.user} password={dialog.temporaryPassword} onClose={close} /> : (["profile", "password", "create", "manage", "reset"] as string[]).includes(dialog.type) ? <form ref={feedback.formRef} onSubmit={(event) => { event.preventDefault(); submitForm(); }} noValidate aria-busy={saving}>
        <p>{dialog.type === "profile" ? "让大家用你喜欢的名字认识你。" : dialog.type === "password" ? "更新后将退出所有设备，请使用新密码重新登录。" : dialog.type === "create" ? "为新成员创建登录账号。首次登录需修改临时密码。" : dialog.type === "reset" ? `为「${dialog.user?.displayName}」设置临时密码，原有会话将失效。` : `@${dialog.user?.username} · 加入于 ${dialog.user?.joined}`}</p>
        <p className="account-required-note"><span aria-hidden="true">*</span> 为必填项</p>
        <fieldset disabled={saving} className="dialog-body">
          {dialog.type === "create" && <div className="form-field">
            <FieldLabel htmlFor={feedback.id("username")}>用户名</FieldLabel>
            <input {...feedback.inputProps("username")} required autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="例如：music.lover" value={username} onChange={(event) => changeField("username", () => setUsername(event.target.value))} />
            <FieldNote id={feedback.noteId("username")} hint="2–24 位英文、数字或 . _ -，以字母或数字开头；不区分大小写，创建后不可修改。" error={feedback.message("username")} success={feedback.interacted("username") && username.trim() && !issues.username ? "用户名可用，创建后不可修改。" : undefined} />
          </div>}
          {["profile", "create", "manage"].includes(dialog.type) && <div className="form-field">
            <FieldLabel htmlFor={feedback.id("displayName")}>昵称</FieldLabel>
            <input {...feedback.inputProps("displayName")} required autoComplete="nickname" value={displayName} placeholder="怎么称呼你" onChange={(event) => changeField("displayName", () => setDisplayName(event.target.value))} />
            <FieldNote id={feedback.noteId("displayName")} hint="支持中文，最多 24 个字符，可随时修改。" error={feedback.message("displayName")} count={characterCount(displayName.trim())} limit={24} />
          </div>}
          {dialog.type === "profile" && <><div className="form-field">
            <FieldLabel htmlFor={feedback.id("bio")} optional>一句话介绍</FieldLabel>
            <textarea {...feedback.inputProps("bio")} rows={2} value={bio} onChange={(event) => changeField("bio", () => setBio(event.target.value))} placeholder="写下此刻的音乐心情" />
            <FieldNote id={feedback.noteId("bio")} hint="记录你的音乐心情，留空也没关系。" error={feedback.message("bio")} count={characterCount(bio)} limit={80} />
          </div><div className="account-color-picker"><span>头像颜色</span><div role="group" aria-label="头像颜色">{(["rose", "sage", "blue"] as const).map((value, index) => <button type="button" className={value} aria-pressed={color === value} aria-label={["玫瑰", "苔绿", "雾蓝"][index]} key={value} onClick={() => setColor(value)}>{color === value && <Check />}</button>)}</div></div></>}
          {["create", "manage"].includes(dialog.type) && roleFields}
          {dialog.type === "create" && <div className="account-auto-password"><KeyRound aria-hidden="true" /><div><strong>临时密码自动生成</strong><p>创建时生成 12–22 位随机密码，成功后可查看或复制。首次登录需修改密码。</p></div></div>}
          {["password", "reset"].includes(dialog.type) && passwordFields}
          {dialog.type === "manage" && dialog.user && <div className="account-manage-actions"><button type="button" disabled={dialog.user.id === user.id} onClick={() => open({ type: "reset", user: dialog.user })}><KeyRound />重置密码</button><button type="button" disabled={Boolean(accountChangeIssue(user, users, dialog.user, { status: dialog.user.status === "active" ? "disabled" : "active" }))} onClick={() => open({ type: "toggle", user: dialog.user })}>{dialog.user.status === "active" ? <ShieldOff /> : <ShieldCheck />}{dialog.user.status === "active" ? "停用账号" : "启用账号"}</button></div>}
        </fieldset>
        {feedback.submitted && feedback.visibleErrors.length > 1 && <p className="form-error" role="alert">还有 {feedback.visibleErrors.length} 项需要完善，请检查标记的输入项。</p>}
        {error && <p className="form-error" id="account-form-error" role="alert">{error}</p>}
        {saveFailed && <div className="account-save-error" role="alert"><AlertTriangle /><span>资料未能保存。原内容保持不变，修改已为你保留。</span></div>}
        <div className="dialog-actions"><button type="button" className="button subtle" onClick={close}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving && <LoaderCircle className="button-spinner" />}{saving ? dialog.type === "create" ? "正在创建…" : "正在保存…" : saveFailed ? "重试保存" : dialog.type === "create" ? "创建账号" : dialog.type === "reset" ? "确认重置" : "保存修改"}</button></div>
      </form> : <>
        <p>{dialog.type === "logout" ? "退出后将暂停播放，你的收藏和歌单会为你保留。" : dialog.type === "session" ? dialog.session ? `「${dialog.session.name}」需要重新登录才能继续使用音乐室。当前设备不受影响。` : `将退出其他 ${otherSessions.length} 台设备，当前设备不受影响。` : dialog.user?.status === "disabled" ? `「${dialog.user.displayName}」可以重新登录，原有收藏与歌单会继续保留。` : `「${dialog.user?.displayName}」将无法登录，现有会话会立即失效。收藏与歌单会保留，之后可以重新启用。`}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button subtle" onClick={close}>取消</button><button className={`button ${dialog.type === "toggle" && dialog.user?.status === "active" ? "danger" : "primary"}`} disabled={saving} onClick={() => {
          if (dialog.type === "logout") { close(); onLogout(); }
          else if (dialog.type === "session") save(() => onRevoke(dialog.session ? [dialog.session.id] : otherSessions.map((session) => session.id)), "已退出所选设备");
          else if (dialog.user) { const status = dialog.user.status === "active" ? "disabled" : "active"; const issue = accountChangeIssue(user, users, dialog.user, { status }); if (issue) { setError(issue); return; } save(() => onUserChange({ ...dialog.user!, status }), status === "active" ? "账号已重新启用" : "账号已停用"); }
        }}>{saving ? <><LoaderCircle className="button-spinner" />正在处理…</> : dialog.type === "toggle" ? dialog.user?.status === "disabled" ? "启用账号" : "停用账号" : "确认退出"}</button></div>
      </>}
    </AccountDialog>}
  </div>;
}
