import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, Check, ArrowUp } from "lucide-react";
import type { AccountField, AccountFieldIssues } from "./account-state";

const fieldOrder: AccountField[] = ["username", "displayName", "bio", "grantConfirmed", "currentPassword", "password", "confirmation"];

export function useAccountFormFeedback(issues: AccountFieldIssues) {
  const prefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const frame = useRef<number | null>(null);
  const [touched, setTouched] = useState<Partial<Record<AccountField, boolean>>>({});
  const [composing, setComposing] = useState<Partial<Record<AccountField, boolean>>>({});
  const [serverIssues, setServerIssues] = useState<AccountFieldIssues>({});
  const [submitted, setSubmitted] = useState(false);
  const [capsLockField, setCapsLockField] = useState<AccountField | null>(null);
  useEffect(() => () => { if (frame.current) window.cancelAnimationFrame(frame.current); }, []);
  const message = (field: AccountField) => composing[field] ? "" : serverIssues[field] || ((submitted || touched[field]) ? issues[field] ?? "" : "");
  const focus = (field: AccountField) => {
    if (frame.current) window.cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(() => {
      const input = formRef.current?.elements.namedItem(field);
      if (input instanceof HTMLElement) {
        input.focus({ preventScroll: true });
        (input.closest(".form-field, .login-form-field, .account-role-field") ?? input).scrollIntoView({ block: "nearest" });
      }
    });
  };
  function reset() {
    if (frame.current) window.cancelAnimationFrame(frame.current);
    setTouched({}); setComposing({}); setServerIssues({}); setSubmitted(false); setCapsLockField(null);
  }
  const checkCapsLock = (field: AccountField, event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (["currentPassword", "password", "confirmation"].includes(field)) setCapsLockField(event.getModifierState("CapsLock") ? field : null);
  };
  const visibleErrors = fieldOrder.filter((field) => message(field));
  return {
    formRef, message, reset, focus, submitted, visibleErrors, capsLockField,
    interacted: (field: AccountField) => Boolean(submitted || touched[field]),
    id: (field: AccountField) => `${prefix}-${field}`,
    noteId: (field: AccountField) => `${prefix}-${field}-note`,
    change: (field: AccountField) => setServerIssues((previous) => ({ ...previous, [field]: "" })),
    setIssue: (field: AccountField, value: string) => { setServerIssues((previous) => ({ ...previous, [field]: value })); focus(field); },
    validate: () => { setSubmitted(true); const first = fieldOrder.find((field) => issues[field]); if (first) focus(first); return !first; },
    inputProps: (field: AccountField) => ({
      id: `${prefix}-${field}`, name: field, "aria-describedby": `${prefix}-${field}-note`, "aria-invalid": Boolean(message(field)),
      onBlur: () => { setTouched((previous) => ({ ...previous, [field]: true })); setCapsLockField(null); },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => checkCapsLock(field, event),
      onKeyUp: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => checkCapsLock(field, event),
      onCompositionStart: () => setComposing((previous) => ({ ...previous, [field]: true })),
      onCompositionEnd: () => setComposing((previous) => ({ ...previous, [field]: false }))
    })
  };
}

export function FieldLabel({ htmlFor, children, optional = false }: { htmlFor: string; children: string; optional?: boolean }) {
  return <label className="account-field-label" htmlFor={htmlFor}>{children}{optional ? <span className="field-optional">选填</span> : <span className="field-required" aria-hidden="true">*</span>}</label>;
}

export function FieldNote({ id, hint, error, success, count, limit }: { id: string; hint: string; error?: string; success?: string; count?: number; limit?: number }) {
  return <div className={`account-field-note ${error ? "is-error" : success ? "is-valid" : ""}`}>
    <p id={id} aria-live="polite">{error ? <AlertCircle aria-hidden="true" /> : success ? <Check aria-hidden="true" /> : null}<span>{error || success || hint}</span></p>
    {count !== undefined && <span className={`field-count ${limit !== undefined && count > limit ? "over-limit" : ""}`} aria-label={`已输入 ${count} 个字符，最多 ${limit} 个字符`}>{count} / {limit}</span>}
  </div>;
}

export function CapsLockNote({ visible }: { visible: boolean }) {
  return visible ? <p className="caps-lock-note" role="status"><ArrowUp aria-hidden="true" />大写锁定已开启，密码区分大小写。</p> : null;
}
