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

/** A button for an owner action; it reports a refusal next to itself. */
export function Action({ label, onClick, danger }: { label: string; onClick: () => Promise<{ done: boolean; error?: string }>; danger?: boolean }) {
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
          setError(result.done ? undefined : result.error ?? 'refused');
        }}
      >
        {label}
      </button>
      {error && <span className="bad small"> {error}</span>}
    </span>
  );
}
