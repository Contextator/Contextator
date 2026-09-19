/**
 * `@joplin/turndown-plugin-gfm` ships no types. It is the maintained fork of turndown's own GFM
 * plugin, and the only export this product uses is `gfm`, the bundle of all of them.
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  type TurndownPlugin = (service: TurndownService) => void;

  export const gfm: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
}
