import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

marked.setOptions({ gfm: true, breaks: true });

// Ticket descriptions and comments are Markdown. Everything is sanitised (no scripts,
// no inline handlers) and links open in a new tab. @[Name](id) mentions become chips.
export function Markdown({ text, className = '' }) {
  const html = useMemo(() => {
    const withMentions = (text || '').replace(/@\[([^\]\n]{1,80})\]\([a-f0-9]{24}\)/g,
      (_m, name) => `<span class="mention">@${escapeHtml(name)}</span>`);
    const clean = DOMPurify.sanitize(marked.parse(withMentions), { ADD_ATTR: ['target'] });
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [text]);
  // eslint-disable-next-line react/no-danger
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
