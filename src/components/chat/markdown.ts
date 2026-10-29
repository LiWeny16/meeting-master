import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const renderer = new MarkdownIt({ breaks: true, linkify: true, html: false });

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(renderer.render(source));
}
