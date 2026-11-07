import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

// Links that agents write open in a new tab, and never with access to this page.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Agent-written Markdown, through a sanitizer: agents can write HTML (§14.4). Without
 * styles too, which the page allows inline: agent text could cover or hide the rest of
 * Needs you, a warning included.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] }), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
