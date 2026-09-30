import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import type { Album, AlbumMetadata, AlbumMetadataCandidate, AlbumMetadataLookup } from "../../shared/types.js";
import { api, ApiError } from "../api.js";
import { errorMessage } from "./catalog-data.js";

function countryName(code: string | null) {
  if (!code) return "地区未注明";
  if (code === "XW") return "全球";
  try { return new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code) ?? code; }
  catch { return code; }
}

function differences(candidate: AlbumMetadataCandidate, album: Album) {
  const notes: string[] = [];
  if (candidate.trackCount !== null && !candidate.matches.tracks) notes.push(`曲目数不同：候选 ${candidate.trackCount} 首 / 本地 ${album.trackCount} 首`);
  else if (candidate.matches.trackList === false) notes.push("曲目内容与本地不同");
  if (candidate.discCount && album.discCount && !candidate.matches.discs) notes.push(`分碟不同：候选 ${candidate.discCount} 碟 / 本地 ${album.discCount} 碟`);
  if (!candidate.matches.artist) notes.push(candidate.artistCompatible ? "艺人署名待核对" : "艺人与本地不同");
  if (!candidate.matches.year && candidate.year !== null && album.year !== null) notes.push(`候选年份 ${candidate.year} 与当前 ${album.year} 不同`);
  if (candidate.official === false) notes.push("非正式发行");
  return notes;
}

export function AlbumMetadataCandidates({ metadata, disabled, selectedId, onChoose, onConflict }: {
  metadata: AlbumMetadata;
  disabled: boolean;
  selectedId: string | null;
  onChoose: (candidate: AlbumMetadataCandidate) => void;
  onConflict: (message: string) => void;
}) {
  const [lookup, setLookup] = useState<AlbumMetadataLookup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const { key } = metadata.album;
  const { revision, onlineLookupEnabled } = metadata;
  useEffect(() => {
    if (!onlineLookupEnabled) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setConflict(false); setLookup(null); setExpanded(false);
    void api.lookupAlbumMetadata(key, revision, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLookup(result);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      const message = errorMessage(reason);
      setError(message);
      if (reason instanceof ApiError && reason.status === 409) { setConflict(true); onConflict(message); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, revision, onlineLookupEnabled, attempt, onConflict]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const syncEdges = () => {
      const top = list.scrollTop > 1;
      const bottom = list.scrollHeight - list.clientHeight - list.scrollTop > 1;
      setScrollEdges((previous) => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    };
    syncEdges();
    list.addEventListener("scroll", syncEdges, { passive: true });
    const observer = new ResizeObserver(syncEdges);
    observer.observe(list);
    for (const item of list.children) observer.observe(item);
    return () => { list.removeEventListener("scroll", syncEdges); observer.disconnect(); };
  }, [lookup, expanded]);

  const candidates = lookup?.candidates ?? [];
  return <section className="metadata-references" aria-label="发行参考" aria-busy={loading}>
    <div className="metadata-reference-heading">
      <h3 id="metadata-references-heading">发行参考{candidates.length > 0 && <span>{candidates.length} 个版本</span>}</h3>
      {onlineLookupEnabled && !error && <button type="button" className="text-button metadata-refresh" disabled={loading || disabled} onClick={() => setAttempt((value) => value + 1)}><RefreshCw aria-hidden="true" />刷新候选</button>}
    </div>
    {!onlineLookupEnabled ? <p className="metadata-reference-message">在线查询未开启，可直接在下方填写。</p>
      : loading ? <p className="metadata-reference-message" role="status"><LoaderCircle className="button-spinner" aria-hidden="true" />正在读取发行参考…</p>
        : error ? <div className="metadata-reference-error" role="status"><p>{conflict ? "专辑信息已更新，请在下方载入最新信息后继续。" : `${error} 手动填写仍可使用。`}</p>{!conflict && <button type="button" className="text-button" disabled={disabled} onClick={() => setAttempt((value) => value + 1)}>重试查询</button>}</div>
          : lookup && !candidates.length ? <p className="metadata-reference-message" role="status">暂未找到对应的发行信息，可直接在下方填写。</p>
            : candidates.length > 0 && <>
              <p className="metadata-reference-caption">来自 MusicBrainz，选用后填入下方，保存时生效。</p>
              {lookup?.partial && <p className="metadata-reference-caution">部分发行详情未能载入，请核对来源后选用。</p>}
              {lookup?.truncated && <p className="metadata-reference-caution">仅展示部分发行版本，请核对来源后选用。</p>}
              <div className={`metadata-candidate-window${scrollEdges.top ? " can-scroll-up" : ""}${scrollEdges.bottom ? " can-scroll-down" : ""}`}>
              <ul ref={listRef} className="metadata-candidate-list" id="metadata-candidate-list" tabIndex={0} aria-label="查到的发行版本">
                {(expanded ? candidates : candidates.slice(0, 2)).map((candidate) => {
                  const notes = differences(candidate, metadata.album);
                  const selected = selectedId === candidate.id;
                  const usable = candidate.year !== null || Boolean(candidate.genre?.trim());
                  const format = candidate.format === "Digital Media" ? "数字发行" : candidate.format;
                  const details = [format, candidate.discCount ? `${candidate.discCount} 碟` : null, candidate.trackCount !== null ? `${candidate.trackCount} 首` : "曲目数未知", candidate.genre ?? "流派未注明"].filter(Boolean).join(" · ");
                  return <li className={`metadata-candidate${selected ? " is-selected" : ""}`} key={candidate.id}>
                    <div className="metadata-candidate-top"><div><strong>{candidate.date || candidate.year || "发行日期未知"} · {countryName(candidate.country)}</strong><span>{details}</span></div>
                      <button type="button" className="metadata-candidate-use" aria-pressed={selected} disabled={disabled || !usable} onClick={() => onChoose(candidate)}>{selected && <Check aria-hidden="true" />}{selected ? "已填入" : usable ? "采用此版本" : "暂无可用信息"}</button></div>
                    <span className="metadata-candidate-artist" title={candidate.artist}>{candidate.artist || "艺人未注明"}</span>
                    <div className="metadata-candidate-bottom"><div>{notes.map((note) => <p key={note}>{note}</p>)}{!notes.length && <span>{candidate.matches.trackList === true ? "曲目内容一致" : "请核对发行版本"}</span>}</div>
                      <a className="metadata-source" href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="查看 MusicBrainz 发行来源">来源<ExternalLink aria-hidden="true" /></a></div>
                  </li>;
                })}
              </ul>
              </div>
              {candidates.length > 2 && <button type="button" className="text-button metadata-expand" aria-expanded={expanded} aria-controls="metadata-candidate-list" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起更多版本" : `展开其余 ${candidates.length - 2} 个版本`}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}
              <span className="sr-only" role="status">{selectedId ? "候选信息已填入，点击保存信息后生效。" : ""}</span>
            </>}
  </section>;
}
