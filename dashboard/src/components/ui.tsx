import { useState, type ReactNode } from 'react';
import { isGithubLink, tone } from '../format.ts';

export function Badge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${tone(status)}`}>{label ?? status.replace(/_/g, ' ')}</span>;
}

/** A link to GitHub, or plain text for anything else. */
export function GithubLink({ url, children }: { url?: string; children: ReactNode }) {
  if (!isGithubLink(url)) return <span>{children}</span>;
  return <a href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** A text box and a button. The text stays until the action is done. */
export function Reply({ label, placeholder, optional, onSend }: { label: string; placeholder?: string; optional?: boolean; onSend: (text: string) => Promise<{ done: boolean; error?: string }> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async () => {
    setBusy(true);
    const result = await onSend(text.trim());
    setBusy(false);
    if (result.done) setText('');
    setError(result.done ? undefined : result.error ?? 'refused: the state changed meanwhile');
  };
  return (
    <div className="reply">
      <textarea rows={2} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
      <button disabled={busy || (!optional && text.trim() === '')} onClick={() => void send()}>{label}</button>
      {error && <span className="bad small"> {error}</span>}
    </div>
  );
}

/** A command for the owner's terminal, with a button that puts it on the clipboard. */
export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Over plain http on a LAN address there is no clipboard API: the old way still works.
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="command">
      <code>{text}</code> <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

/** A button for an owner action; it reports a refusal next to itself, or what went wrong beside an action that was done. */
export function Action({ label, onClick, danger }: { label: string; onClick: () => Promise<{ done: boolean; error?: string; warning?: string }>; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span>
      <button
        className={danger ? 'danger' : undefined}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await onClick();
          setBusy(false);
          setError(result.done ? result.warning : result.error ?? 'refused');
        }}
      >
        {label}
      </button>
      {error && <span className="bad small"> {error}</span>}
    </span>
  );
}
