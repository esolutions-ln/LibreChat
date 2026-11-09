import type { TNmbColumn } from 'librechat-data-provider';

export type PromptInput = {
  name: string;
  /** Only the columns the user chose to share. */
  columns: Pick<TNmbColumn, 'name' | 'kind'>[];
  /** The synthetic twin as CSV. Never real data. */
  csv: string;
  allowedImports: string[];
  question?: string;
};

export const DEFAULT_IMPORTS = [
  'pandas',
  'numpy',
  'math',
  'statistics',
  'datetime',
  'json',
  're',
  'collections',
  'itertools',
  'decimal',
  'matplotlib',
  'plotly',
];

/**
 * Builds the chat prompt for the code-writing step. The sample is synthetic, and the code contract
 * mirrors docs/nmb/ANALYSIS.md so the sandbox accepts what the model writes.
 */
export function buildAnalysisPrompt(input: PromptInput): string {
  const imports = input.allowedImports.length > 0 ? input.allowedImports : DEFAULT_IMPORTS;
  const schema = input.columns.map((c) => `- ${c.name} (${c.kind})`).join('\n');
  const question = input.question?.trim();
  const parts = [
    'Write ONE Python 3 script that analyses a tabular dataset. The sample below is synthetic: ' +
      'it has the same columns and types as the real file, but the values are fake. The script ' +
      'will later run on the real file inside a restricted sandbox.',
    `Dataset: ${input.name}`,
    `Columns:\n${schema}`,
    `Synthetic sample (CSV):\n\`\`\`csv\n${input.csv.trim()}\n\`\`\``,
    [
      'Rules for the script:',
      '- Two globals are provided: DATA_PATH (path to the CSV) and OUTPUT_DIR (output folder).',
      '- Read the data with pd.read_csv(DATA_PATH). Do not hard-code any other path.',
      '- Write results only under OUTPUT_DIR (.csv, .json, .html, .png or .txt files).',
      '- Print short summaries with print().',
      `- Only import: ${imports.join(', ')}.`,
      '- Do not use the network, subprocess, os, sys, pathlib, shutil, open(), eval, exec, ' +
        'compile, __import__ or dunder attributes.',
      '- Read only CSV with pd.read_csv. Do not use DataFrame.query/eval, other read_* functions, ' +
        'numpy load/loadtxt/fromfile or memmap.',
      '- Aggregate the data. Do not print or save raw rows beyond what the analysis needs.',
      '- Comment the code and handle missing or invalid values explicitly.',
    ].join('\n'),
  ];
  if (question) {
    parts.push(`Analysis to perform:\n${question}`);
  }
  parts.push('Reply with a single ```python code block and a short explanation.');
  return parts.join('\n\n');
}

/** Splits a rule id such as `import:os@3` into its rule and line. */
export function parseViolation(v: string): { rule: string; line?: number } {
  const m = /^(.*?)@L?(\d+)$/.exec(v);
  return m ? { rule: m[1], line: Number(m[2]) } : { rule: v };
}
