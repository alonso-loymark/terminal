// Before Prism loads (lib/highlight.ts imports this first): manual mode, so it never scans the
// page on its own (`highlightAll`) and never listens to worker messages. Brisa only calls its
// tokenizer.
(globalThis as { Prism?: unknown }).Prism = { manual: true, disableWorkerMessageHandler: true };

export {};
