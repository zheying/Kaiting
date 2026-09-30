import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ExternalLink, Info, LoaderCircle, RotateCcw } from "lucide-react";
import type { AlbumMetadata } from "../../shared/types.js";
import { api, ApiError, artworkUrl } from "../api.js";
import { Artwork } from "./StateComponents.js";
import { errorMessage } from "./catalog-data.js";
import { emptyMetadataDraft, metadataDraftReducer } from "./metadata-draft.js";
import { AlbumMetadataCandidates } from "./AlbumMetadataCandidates.js";
import "./metadata.css";

export function AlbumMetadataForm({ albumId, onSaved, onClose, onBusyChange }: {
  albumId: string; onSaved: (metadata: AlbumMetadata) => void; onClose: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [metadata, setMetadata] = useState<AlbumMetadata | null>(null);
  const [draft, dispatch] = useReducer(metadataDraftReducer, emptyMetadataDraft);
  const { year, genre } = draft;
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [touched, setTouched] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lookupConflict = useCallback((message: string) => { setError(message); setConflict(true); }, []);
  const savingRef = useRef(false);
  const yearRef = useRef<HTMLInputElement>(null);
  const yearError = year.trim() && !/^[1-9]\d{3}$/.test(year.trim()) ? "请输入有效的四位年份。" : "";
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setMetadata(null); setError(""); setConflict(false); setSelectedId(null);
    void api.albumMetadata(albumId, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setMetadata(value); dispatch({ type: "replace", values: { year: value.album.year, genre: value.album.genre ?? null } }); setTouched(false);
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [albumId, attempt]);
  useEffect(() => { if (!loading && metadata) yearRef.current?.focus(); }, [loading]);

  async function save() {
    if (!metadata || savingRef.current) return;
    setTouched(true);
    if (yearError) { yearRef.current?.focus(); return; }
    savingRef.current = true; setSaving(true); onBusyChange(true); setError(""); setConflict(false);
    try {
      const result = await api.saveAlbumMetadata(albumId, { year: year.trim() ? Number(year) : null, genre: genre.trim() || null }, metadata.revision);
      onSaved(result);
    } catch (reason) {
      setError(errorMessage(reason)); setConflict(reason instanceof ApiError && reason.status === 409);
    } finally { savingRef.current = false; setSaving(false); onBusyChange(false); }
  }

  return <form className="album-metadata-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={loading || saving}>
    <h2>编辑专辑信息</h2>
    {loading ? <div className="metadata-loading" role="status"><LoaderCircle className="button-spinner" />正在读取专辑信息…</div> : metadata && <>
      <div className="metadata-album-summary">
        <Artwork src={artworkUrl(metadata.album.artworkTrackId) ?? ""} alt="" className="metadata-cover" />
        <div><strong>{metadata.album.title}</strong><span>{metadata.album.artist || "未知艺人"} · {metadata.album.trackCount} 首歌曲</span></div>
      </div>
      <section className="metadata-provenance" aria-label="信息来源">
        {metadata.automatic ? <div className="metadata-source-row"><span>已在后台自动补全，可在下方修正。</span><a className="metadata-source" href={metadata.automatic.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="查看自动补全的 MusicBrainz 来源">MusicBrainz<ExternalLink /></a></div>
          : <p>{metadata.autoFillBlocked ? "已保留人工设置，后台不会自动修改。" : metadata.autoCompleteEnabled ? "扫描后会自动补齐可信信息，未确认的信息保留空白。" : "可在下方修正信息，保存后对所有成员可见。"}</p>}
      </section>
      <AlbumMetadataCandidates metadata={metadata} disabled={saving || conflict} selectedId={selectedId} onConflict={lookupConflict} onChoose={(candidate) => {
        if (candidate.year !== null) dispatch({ type: "edit", field: "year", value: String(candidate.year) });
        if (candidate.genre?.trim()) dispatch({ type: "edit", field: "genre", value: candidate.genre });
        setSelectedId(candidate.id); setTouched(false);
      }} />
      <fieldset disabled={saving} className="metadata-fields">
        <div className="metadata-fields-grid">
          <label className="form-field" htmlFor="metadata-year">发行年份
            <input ref={yearRef} id="metadata-year" inputMode="numeric" maxLength={4} placeholder="例如：2018" value={year} onChange={(event) => { dispatch({ type: "edit", field: "year", value: event.target.value }); setSelectedId(null); }} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(yearError)} aria-describedby={(touched && yearError) || metadata.original.year ? "metadata-year-hint" : undefined} />
            {((touched && yearError) || metadata.original.year) && <small id="metadata-year-hint" className={touched && yearError ? "form-error" : ""}>{touched && yearError ? yearError : `扫描信息：${metadata.original.year}`}</small>}
          </label>
          <label className="form-field" htmlFor="metadata-genre">音乐流派
            <input id="metadata-genre" maxLength={80} placeholder="例如：游戏原声、古典、爵士" value={genre} onChange={(event) => { dispatch({ type: "edit", field: "genre", value: event.target.value }); setSelectedId(null); }} aria-describedby={metadata.original.genre ? "metadata-genre-hint" : undefined} />
            {metadata.original.genre && <small id="metadata-genre-hint">扫描信息：{metadata.original.genre}</small>}
          </label>
        </div>
        <div className="metadata-note"><Info aria-hidden="true" /><p>手动保存后，后台与重新扫描都不会覆盖你的设置。<br />音乐文件保持原样，留空沿用扫描信息。</p></div>
      </fieldset>
    </>}
    {(error || conflict) && <div className="metadata-error" role="alert">{error && <p>{error}</p>}{(!metadata || conflict) && <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>{conflict ? "载入最新信息" : "重新载入"}</button>}</div>}
    <div className="dialog-actions metadata-actions">{metadata && <button type="button" className="metadata-restore text-button" disabled={saving} onClick={() => { dispatch({ type: "replace", values: metadata.original }); setTouched(false); setSelectedId(null); }}><RotateCcw />恢复扫描信息</button>}<button type="button" className="button subtle" onClick={onClose} disabled={saving}>取消</button><button type="submit" className="button primary" disabled={loading || !metadata || saving || conflict}>{saving && <LoaderCircle className="button-spinner" />}{saving ? "正在保存…" : "保存信息"}</button></div>
  </form>;
}
