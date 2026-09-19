/**
 * `mammoth` ships no types and has no `@types/` package. Declared here rather than typed as `any` at
 * the call site: the surface this product uses is three functions wide, and writing it down is what
 * makes a change in the library's shape a compile error instead of a runtime one.
 *
 * Only what `services/doc-types/docx.ts` calls is declared. Everything else the library exports —
 * the Markdown converter, the style-map DSL, the CLI — is deliberately absent.
 */
declare module 'mammoth' {
  interface MammothImage {
    contentType?: string;
    altText?: string;
    read(encoding: string): Promise<string>;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
  }

  /** The attributes of the `<img>` mammoth writes; `src: ''` is how a picture is dropped. */
  interface ImageAttributes {
    src: string;
    alt?: string;
  }

  interface ConvertInput {
    buffer?: Buffer;
    path?: string;
    arrayBuffer?: ArrayBuffer;
  }

  interface ConvertOptions {
    styleMap?: string | string[];
    includeDefaultStyleMap?: boolean;
    convertImage?: unknown;
    ignoreEmptyParagraphs?: boolean;
    idPrefix?: string;
  }

  interface ConvertMessage {
    type: string;
    message: string;
  }

  interface ConvertResult {
    value: string;
    messages: ConvertMessage[];
  }

  const images: {
    imgElement(convert: (image: MammothImage) => Promise<ImageAttributes>): unknown;
  };

  function convertToHtml(input: ConvertInput, options?: ConvertOptions): Promise<ConvertResult>;
  function extractRawText(input: ConvertInput): Promise<ConvertResult>;

  export { convertToHtml, extractRawText, images };
  export type { ConvertMessage, ConvertOptions, ConvertResult, ImageAttributes, MammothImage };

  const mammoth: {
    convertToHtml: typeof convertToHtml;
    extractRawText: typeof extractRawText;
    images: typeof images;
  };
  export default mammoth;
}
