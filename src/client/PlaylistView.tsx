import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Play, Plus } from "lucide-react";
import { api } from "./api.js";
import { createLatestRequest } from "./async-state.js";
import { movePlaylistTrack } from "./playlist-state.js";
import type { Playlist, PlaylistDetail, Track } from "../shared/types.js";

interface PlaylistViewProps {
  id: string;
  refresh: number;
  busy: boolean;
  mutate: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
  onChanged: (playlist: Playlist, refreshDetail?: boolean) => void;
  onDeleted: (id: string) => void;
  onBack: () => void;
  onBrowse: () => void;
  onPlay: (tracks: Track[]) => void;
  renderTrack: (track: Track, index: number, tracks: Track[], remove: () => Promise<void>, busy: boolean) => ReactNode;
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
}

export function PlaylistView({ id, refresh, busy, mutate, onChanged, onDeleted, onBack, onBrowse, onPlay, renderTrack }: PlaylistViewProps) {
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [reload, setReload] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [failedRemoval, setFailedRemoval] = useState<Track | null>(null);
  const [draft, setDraft] = useState<{ tracks: Track[]; revision: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lifetime = useRef(0);
  const actionPending = useRef(false);
  const requests = useRef(createLatestRequest());
  const confirmRef = useRef<HTMLDivElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocus = useRef(false);
  const disabled = busy || Boolean(action) || loading;

  useEffect(() => {
    lifetime.current += 1;
    return () => { lifetime.current += 1; requests.current.cancel(); };
  }, []);

  useEffect(() => {
    const request = requests.current.begin();
    setLoading(true);
    setLoadError("");
    setNotFound(false);
    api.playlist(id, request.signal).then((next) => {
      if (!request.isCurrent()) return;
      setDetail(next);
      const existingDraft = draftRef.current;
      if (existingDraft && existingDraft.revision !== next.revision) {
        setConflict(true);
        setError("歌单已在其他操作中发生变化。顺序草稿已保留，请重新加载后再调整。");
      }
    }).catch((failure) => {
      if (!request.isCurrent()) return;
      setNotFound(errorStatus(failure) === 404);
      setLoadError(failure instanceof Error ? failure.message : "歌单加载失败，请重试。");
    }).finally(() => { if (request.isCurrent()) setLoading(false); });
    return () => requests.current.cancel();
  }, [id, refresh, reload]);

  function cancelDeleteConfirmation() {
    if (actionPending.current) return;
    restoreDeleteFocus.current = true;
    setConfirmDelete(false);
    setError("");
  }

  useEffect(() => {
    if (!confirmDelete) return;
    confirmRef.current?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") cancelDeleteConfirmation();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [confirmDelete]);

  useEffect(() => {
    if (confirmDelete || disabled || !restoreDeleteFocus.current) return;
    const trigger = deleteTriggerRef.current;
    if (!trigger?.isConnected) return;
    // The action buttons are remounted after the confirmation closes.
    trigger.focus();
    restoreDeleteFocus.current = false;
  }, [confirmDelete, disabled]);

  async function run<T>(kind: string, operation: () => Promise<T>, apply: (result: T) => void, notify: (result: T) => void) {
    if (actionPending.current) throw new Error("歌单正在更新，请稍候再试。");
    actionPending.current = true;
    const generation = lifetime.current;
    requests.current.cancel();
    setLoading(false);
    setAction(kind);
    setError("");
    setMessage("");
    setFailedRemoval(null);
    try {
      const result = await mutate(id, operation);
      notify(result);
      if (generation !== lifetime.current) return;
      requests.current.cancel();
      setLoading(false);
      setLoadError("");
      setNotFound(false);
      apply(result);
    } catch (failure) {
      if (generation === lifetime.current) {
        if (errorStatus(failure) === 404) setNotFound(true);
        if (errorStatus(failure) === 409) {
          setConflict(true);
          setError("歌单已发生变化，顺序草稿已保留。请放弃草稿并重新加载后再调整。");
        } else setError(failure instanceof Error ? failure.message : "操作失败，请重试。");
      }
      throw failure;
    } finally {
      actionPending.current = false;
      if (generation === lifetime.current) setAction("");
    }
  }

  function rename() {
    const nextName = name.trim();
    if (!nextName) { setError("请输入歌单名称。"); return; }
    void run("rename", async () => {
      const playlist = await api.renamePlaylist(id, nextName);
      onChanged(playlist, false);
      return api.playlist(id);
    }, (next) => {
      setDetail(next);
      setEditingName(false);
      setMessage("歌单名称已更新。");
    }, () => {}).catch(() => {});
  }

  async function remove(track: Track) {
    setFailedRemoval(null);
    try {
      await run(`remove:${track.id}`, () => api.removeFromPlaylist(id, track.id), (next) => {
        setDetail(next);
        setMessage(`已从歌单移除「${track.title}」。`);
      }, (next) => onChanged(next.playlist));
    } catch (failure) {
      setFailedRemoval(track);
      throw failure;
    }
  }

  function saveOrder() {
    if (!draft || conflict) return;
    void run("reorder", () => api.reorderPlaylist(id, draft.tracks.map((track) => track.id), draft.revision), (next) => {
      setDetail(next);
      setDraft(null);
      setMessage("顺序已保存，下次播放此歌单时生效。");
    }, (next) => onChanged(next.playlist)).catch(() => {});
  }

  function discardDraft() {
    setDraft(null);
    setConflict(false);
    setError("");
    setReload((value) => value + 1);
  }

  if (notFound) return <section className="section playlist-empty">
    <h2>歌单不存在或已删除</h2>
    <p>音乐文件和正在播放的队列不受影响。</p>
    <button type="button" onClick={onBack}>返回歌单列表</button>
  </section>;

  if (loading && !detail) return <section className="section"><p className="request-feedback" role="status"><Loader2 className="spin" /> 正在加载歌单…</p></section>;
  if (loadError) return <section className="section"><div className="request-feedback error-text" role="alert"><span>{loadError}</span><button type="button" onClick={() => setReload((value) => value + 1)}>重试</button><button type="button" onClick={onBack}>返回歌单列表</button></div></section>;
  if (!detail) return null;
  const minutes = Math.round(detail.playlist.duration / 60);

  return <section className="section playlist-detail" aria-busy={disabled || loading}>
    <div className="playlist-detail-topline"><button type="button" className="playlist-back" onClick={onBack}>返回歌单列表</button><span>{detail.tracks.length} 首 · {minutes} 分钟</span></div>
    <div className="section-title"><h2>{detail.playlist.name}</h2></div>
    {editingName ? <form className="playlist-rename" onSubmit={(event) => { event.preventDefault(); rename(); }}>
      <label>歌单名称<input value={name} disabled={disabled} maxLength={200} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <button type="submit" disabled={disabled}>{action === "rename" ? "保存中…" : "保存名称"}</button>
      <button type="button" disabled={disabled} onClick={() => { setEditingName(false); setError(""); }}>取消</button>
    </form> : null}
    {!draft && !confirmDelete ? <div className="playlist-actions">
      <button type="button" className="primary" disabled={disabled || !detail.tracks.length} onClick={() => onPlay(detail.tracks)}><Play /> 播放歌单</button>
      <button type="button" disabled={disabled} onClick={() => { setName(detail.playlist.name); setEditingName(true); setError(""); }}>重命名</button>
      <button type="button" disabled={disabled || detail.tracks.length < 2} onClick={() => { setEditingName(false); setDraft({ tracks: [...detail.tracks], revision: detail.revision }); setConflict(false); setError(""); setMessage(""); }}>调整顺序</button>
      <button ref={deleteTriggerRef} type="button" className="danger-action" disabled={disabled} onClick={() => { restoreDeleteFocus.current = false; setEditingName(false); setConfirmDelete(true); setError(""); }}>删除歌单</button>
    </div> : null}
    {confirmDelete ? <div className="playlist-delete-confirm" role="alertdialog" aria-labelledby="playlist-delete-title" aria-describedby="playlist-delete-description" tabIndex={-1} ref={confirmRef}>
      <h3 id="playlist-delete-title">删除歌单「{detail.playlist.name}」？</h3>
      <p id="playlist-delete-description">将删除此歌单及其中的歌曲关联。音乐文件、收藏和当前播放队列都会保留。</p>
      <div className="playlist-actions"><button type="button" className="danger-action" disabled={disabled} onClick={() => void run("delete", () => api.deletePlaylist(id), () => {}, () => onDeleted(id)).catch(() => {})}>{action === "delete" ? "正在删除…" : "确认删除歌单"}</button><button type="button" disabled={disabled} onClick={cancelDeleteConfirmation}>取消</button></div>
    </div> : null}
    {error ? <div className="request-feedback error-text" role="alert"><span>{error}</span>{failedRemoval && !disabled ? <button type="button" onClick={() => void remove(failedRemoval).catch(() => {})}>重试移除</button> : null}</div> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
    {action ? <p className="request-feedback" role="status"><Loader2 className="spin" /> 正在更新歌单…</p> : null}
    {draft ? <>
      <div className="playlist-sort-toolbar">
        <p>使用上移、下移调整顺序；保存后在下次播放歌单时生效，当前播放队列保持原样。</p>
        <div className="playlist-actions"><button className="primary" type="button" disabled={disabled || conflict} onClick={saveOrder}>{action === "reorder" ? "保存中…" : "保存顺序"}</button><button type="button" disabled={disabled} onClick={discardDraft}>{conflict ? "放弃草稿并重新加载" : "取消调整"}</button></div>
      </div>
      <ol className="playlist-sort-list">{draft.tracks.map((track, index) => <li key={track.id}>
        <span className="playlist-sort-index">{index + 1}</span><div><strong>{track.title}</strong><small>{track.artist ?? "未知艺人"}</small></div>
        <button type="button" disabled={disabled || conflict || index === 0} aria-label={`上移 ${track.title}`} onClick={() => setDraft((value) => value ? { ...value, tracks: movePlaylistTrack(value.tracks, index, index - 1) } : value)}><ArrowUp /><span>上移</span></button>
        <button type="button" disabled={disabled || conflict || index === draft.tracks.length - 1} aria-label={`下移 ${track.title}`} onClick={() => setDraft((value) => value ? { ...value, tracks: movePlaylistTrack(value.tracks, index, index + 1) } : value)}><ArrowDown /><span>下移</span></button>
      </li>)}</ol>
    </> : detail.tracks.length ? <div className="track-list">{detail.tracks.map((track, index) => renderTrack(track, index + 1, detail.tracks, () => remove(track), disabled || confirmDelete))}</div> : <div className="playlist-empty"><h3>歌单还是空的</h3><p>前往曲库，在歌曲的“更多”菜单中选择“添加到歌单”。</p><button type="button" onClick={onBrowse}><Plus /> 前往曲库添加歌曲</button></div>}
  </section>;
}
