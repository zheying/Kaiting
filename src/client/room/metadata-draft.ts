import type { AlbumMetadataValues } from "../../shared/types.js";

type Field = "year" | "genre";
export interface MetadataDraft {
  year: string; genre: string;
  edits: Record<Field, number>;
  generated: Record<Field, boolean>;
}
export const emptyMetadataDraft: MetadataDraft = { year: "", genre: "", edits: { year: 0, genre: 0 }, generated: { year: false, genre: false } };
type Action = { type: "replace"; values: AlbumMetadataValues }
  | { type: "edit"; field: Field; value: string }
  | { type: "fill"; values: AlbumMetadataValues; expectedEdits: MetadataDraft["edits"] };

export function metadataDraftReducer(state: MetadataDraft, action: Action): MetadataDraft {
  if (action.type === "replace") return {
    year: action.values.year?.toString() ?? "", genre: action.values.genre ?? "",
    edits: { year: state.edits.year + 1, genre: state.edits.genre + 1 }, generated: { year: false, genre: false }
  };
  if (action.type === "edit") return {
    ...state, [action.field]: action.value,
    edits: { ...state.edits, [action.field]: state.edits[action.field] + 1 }, generated: { ...state.generated, [action.field]: false }
  };
  const next = { ...state, generated: { ...state.generated } };
  for (const field of ["year", "genre"] as const) {
    // Late responses must respect even a field that was typed into and then cleared.
    if (state.edits[field] !== action.expectedEdits[field] || (state[field].trim() && !state.generated[field])) continue;
    next[field] = action.values[field]?.toString() ?? "";
    next.generated[field] = Boolean(next[field]);
  }
  return next;
}
