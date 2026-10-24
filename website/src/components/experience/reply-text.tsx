import { Fragment, type ReactNode } from 'react';

/**
 * Agent replies are written in light markdown: paragraphs, **bold**, numbered or bulleted lists and pipe tables.
 * Renders just that, as React elements (never raw HTML), so model output can't inject markup.
 */
export function ReplyText({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    if (isTableRow(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isTableRow(lines[i].trim()); i++) rows.push(cells(lines[i].trim()));
      blocks.push(
        <table key={blocks.length} className="reply-table">
          <thead><tr>{head.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const list = line.match(/^(\d+[.)]|[-*•])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = lines[i].trim().match(/^(\d+[.)]|[-*•])\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(m[2]);
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={blocks.length} className="reply-list">{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</Tag>);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !isTableRow(lines[i].trim()) && !/^(\d+[.)]|[-*•])\s+/.test(lines[i].trim()); i++) para.push(lines[i].trim());
    blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
  }
  return <div className="reply-text">{blocks}</div>;
}

const isTableRow = (line: string) => line.startsWith('|') && line.endsWith('|') && line.length > 2;
const cells = (line: string) => line.slice(1, -1).split('|').map(c => c.trim());

/** **bold** and `code` inside a line. */
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code>
      : <Fragment key={i}>{part}</Fragment>);
}
