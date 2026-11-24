// The part of Prism (prismjs, CommonJS without types) that lib/highlight.ts uses: grammars and
// the tokenizer. Prism's HTML output is never used.
declare module 'prismjs' {
  export interface Token {
    type: string;
    content: string | Token | (string | Token)[];
    alias?: string | string[];
  }
  export type Grammar = Record<string, unknown>;
  const Prism: {
    languages: Record<string, Grammar | undefined>;
    tokenize(text: string, grammar: Grammar): (string | Token)[];
    manual?: boolean;
  };
  export default Prism;
}

declare module 'prismjs/components/*';
