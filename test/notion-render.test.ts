import { describe, expect, it } from 'vitest';
import { frontmatter, pageFileStem, pageTitle, renderBlocks, renderRichText, type NotionBlock } from '../src/services/sources/notion-render.js';

const rt = (text: string, extra: Record<string, unknown> = {}) => ({ plain_text: text, ...extra });
const block = (type: string, payload: Record<string, unknown>, children?: NotionBlock[]): NotionBlock => ({ id: type, type, [type]: payload, has_children: Boolean(children), children });

describe('notion renderer', () => {
  it('renders rich text annotations and links', () => {
    expect(renderRichText([rt('bold', { annotations: { bold: true } }), rt(' and '), rt('code', { annotations: { code: true } }), rt('link', { href: 'https://x.y' })])).toBe(
      '**bold** and `code`[link](https://x.y)',
    );
  });

  it('renders headings, lists (with nesting and numbering), quotes, code and tables', () => {
    const md = renderBlocks([
      block('heading_1', { rich_text: [rt('Title')] }),
      block('paragraph', { rich_text: [rt('Intro')] }),
      block('bulleted_list_item', { rich_text: [rt('one')] }, [block('bulleted_list_item', { rich_text: [rt('nested')] })]),
      block('numbered_list_item', { rich_text: [rt('first')] }),
      block('numbered_list_item', { rich_text: [rt('second')] }),
      block('to_do', { rich_text: [rt('done')], checked: true }),
      block('quote', { rich_text: [rt('wise words')] }),
      block('code', { rich_text: [rt('console.log(1)')], language: 'javascript' }),
      block('callout', { rich_text: [rt('note')], icon: { emoji: '💡' } }),
      block('table', { has_column_header: true }, [block('table_row', { cells: [[rt('a')], [rt('b')]] }), block('table_row', { cells: [[rt('1')], [rt('2')]] })]),
      block('divider', {}),
      block('unsupported', {}),
    ]);
    expect(md).toBe(
      [
        '# Title',
        '',
        'Intro',
        '',
        '- one\n  - nested',
        '',
        '1. first',
        '',
        '2. second',
        '',
        '- [x] done',
        '',
        '> wise words',
        '',
        '```javascript\nconsole.log(1)\n```',
        '',
        '> 💡 note',
        '',
        '| a | b |\n| --- | --- |\n| 1 | 2 |',
        '',
        '---',
      ].join('\n'),
    );
  });

  it('derives titles, file stems and frontmatter', () => {
    expect(pageTitle({ properties: { Name: { type: 'title', title: [rt('Getting '), rt('Started')] } } })).toBe('Getting Started');
    expect(pageFileStem('Çok Güzel Başlık!', '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d')).toBe('cok-guzel-baslik--1a2b3c4d');
    expect(pageFileStem('', 'abcdef0123456789')).toBe('untitled--abcdef01');
    expect(frontmatter({ title: 'A "quoted" title', notion_id: 'x' })).toBe('---\ntitle: "A \\"quoted\\" title"\nnotion_id: "x"\n---\n');
  });
});
